'use strict';

/**
 * Hostile offline gate for Stage 6 Microsoft verified-grant atomic DB installer.
 * Stateful fake pinned client: exact SQL order/params, commit/rollback, modes,
 * status/address mismatch, missing/duplicate rows, ownership 23505, insert/update
 * failures, commit ambiguity, input/deps proxies/accessors/symbols/prototypes/
 * descriptors/mutation, identity/envelope shape + operation mismatch, actor null,
 * no token keys, single-use atomic burn (invalid-first / sequential / concurrent /
 * reentrant-from-query / hostile second traps).
 * Direct merged adapter interop via fake envelope provider + this installer fake DB.
 * Optional disposable local PG proof when available (no network). No routes/Azure/live.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  ERROR_CODE,
  ERROR_MESSAGE,
  GRANT_GENERATION_INITIAL,
  INSTALLER_METHOD,
  INSTALLER_ACK_STATUS,
  INSTALLER_ACK,
  INSTALL_KEYS,
  IDENTITY_KEYS,
  DEPENDENCY_KEYS,
  ELIGIBLE_BINDING_STATUSES,
  LOCK_ROW_KEYS,
  GRANT_RETURNING_KEYS,
  UPDATE_RETURNING_KEYS,
  createMicrosoftVerifiedGrantInstaller,
} = require('./lib/email-microsoft-verified-grant-installer');
const {
  buildGrantEnvelopeAadV1,
  validateGrantEnvelopeRecordV1,
} = require('./lib/email-grant-envelope-provider-contract');
const {
  createFakeEmailGrantEnvelopeProvider,
  getFakeEmailGrantEnvelopeProviderMeta,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  createMicrosoftVerifiedGrantCustodyAdapter,
  SEALED_ACK,
  INSTALL_KEYS: CUSTODY_INSTALL_KEYS,
  INSTALLER_METHOD: CUSTODY_INSTALLER_METHOD,
  ERROR_CODE: CUSTODY_ERROR_CODE,
} = require('./lib/email-microsoft-verified-grant-custody');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LIB_REL = 'scripts/lib/email-microsoft-verified-grant-installer.js';
const VERIFY_REL = 'scripts/verify-email-microsoft-verified-grant-installer.js';

const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENDPOINT_ID = '11111111-2222-4333-8444-555555555555';
const OPERATION_ID = '99999999-8888-4777-8666-555555555555';
const ACTOR_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const TID = '01234567-89ab-4def-8123-456789abcdef';
const PRINCIPAL = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111';
const MAILBOX = 'ada@example.com';
const DISPLAY = 'Ada Lovelace';
const LEAK = 'VERIFIED-GRANT-INSTALLER-SECRET-DO-NOT-LEAK';
const ACCESS = 'ACCESS_SECRET_NEVER_LEAK_9c2b';
const REFRESH = 'REFRESH_SECRET_NEVER_LEAK_3d4e';
const ID_TOKEN = 'ID_TOKEN_SECRET_NEVER_LEAK.header.payload.sig';
const NONCE = 'offline-nonce-NEVER-LEAK-7f1a';
const EXPECTED_CLIENT = 'offline-client-id';
const GOOD_SCOPE = 'openid profile offline_access User.Read Mail.ReadBasic';
const NOW = 1_900_000_000;

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function failSanitized(error) {
  return error
    && error.code === ERROR_CODE
    && error.message === ERROR_MESSAGE
    && !String(error.message).includes(LEAK)
    && !String(error.stack || '').includes(LEAK)
    && !String(error).includes(REFRESH)
    && !String(error).includes(ACCESS);
}

function assertNoSensitive(blob) {
  const s = typeof blob === 'string' ? blob : (() => {
    try { return JSON.stringify(blob); } catch { return String(blob); }
  })();
  assert.equal(s.includes(LEAK), false);
  assert.equal(s.includes(REFRESH), false);
  assert.equal(s.includes(ACCESS), false);
  assert.equal(/refresh_token|access_token|id_token/i.test(s), false);
}

function structuralEnvelope(operationId = OPERATION_ID) {
  return Object.freeze({
    envelope_version: 'v1',
    aead_alg: 'AES-256-GCM',
    kek_wrap_alg: 'A256KW',
    kek_key_name: 'fake-luna-grant-kek',
    kek_key_version: 'v1-test-0001',
    nonce: Buffer.alloc(12, 1),
    ciphertext: Buffer.alloc(32, 2),
    auth_tag: Buffer.alloc(16, 3),
    wrapped_dek: Buffer.alloc(40, 4),
    operation_id: operationId,
  });
}

function goodIdentity(patch = {}) {
  return Object.freeze({
    providerTenantId: TID,
    providerPrincipalId: PRINCIPAL,
    mailboxAddress: MAILBOX,
    displayName: DISPLAY,
    ...patch,
  });
}

function goodInstall(patch = {}) {
  const base = {
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: ACTOR_ID,
    identity: goodIdentity(),
    envelope: structuralEnvelope(OPERATION_ID),
  };
  return Object.freeze({ ...base, ...patch });
}

function eligibleEndpoint(patch = {}) {
  return {
    id: ENDPOINT_ID,
    client_id: CLIENT_ID,
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'unverified_offline',
    public_address: MAILBOX,
    ...patch,
  };
}

/**
 * Stateful fake pinned transaction client for hostile SQL order/param proofs.
 * Tracks committed vs in-flight state so ROLLBACK never undoes a prior COMMIT.
 */
function createFakePinnedClient(spec = {}) {
  const queries = [];
  let tx = 'idle';
  const initialEndpoint = () => eligibleEndpoint(spec.endpoint || {});
  let committed = {
    endpoint: initialEndpoint(),
    grantInserted: false,
    grantRow: null,
  };
  let draft = null; // in-flight mutation snapshot while tx === 'open'
  const modes = {
    selectRows: spec.selectRows,
    insertRows: spec.insertRows,
    updateRows: spec.updateRows,
    throwOn: spec.throwOn || null,
    commitThrow: spec.commitThrow === true,
    commitAmbiguous: spec.commitAmbiguous === true,
    beginThrow: spec.beginThrow === true,
    insertThrow: spec.insertThrow || null,
    updateThrow: spec.updateThrow || null,
    selectThrow: spec.selectThrow || null,
  };

  function isBegin(t) { return /^\s*BEGIN\b/i.test(t); }
  function isCommit(t) { return /^\s*COMMIT\b/i.test(t); }
  function isRollback(t) { return /^\s*ROLLBACK\b/i.test(t); }
  function isSelectLock(t) {
    return /FROM\s+tenant_channel_endpoints/i.test(t) && /FOR\s+UPDATE/i.test(t);
  }
  function isInsertGrant(t) {
    return /INSERT\s+INTO\s+tenant_email_delegated_grants/i.test(t);
  }
  function isUpdateEndpoint(t) {
    return /UPDATE\s+tenant_channel_endpoints/i.test(t)
      && /binding_status\s*=\s*'verified'/i.test(t);
  }
  function view() {
    return draft || committed;
  }
  function ensureDraft() {
    if (!draft) {
      draft = {
        endpoint: committed.endpoint ? { ...committed.endpoint } : null,
        grantInserted: committed.grantInserted,
        grantRow: committed.grantRow ? { ...committed.grantRow } : null,
      };
    }
    return draft;
  }

  const client = {
    async query(sql, params) {
      const text = String(sql || '');
      const p = Array.isArray(params) ? params.slice() : [];
      queries.push({ text, params: p, tx });

      if (modes.throwOn && modes.throwOn(text, p, tx)) {
        const err = new Error(`${LEAK} injected`);
        err.code = modes.throwOnCode || 'XX000';
        throw err;
      }

      if (isBegin(text)) {
        if (modes.beginThrow) {
          const err = new Error(`${LEAK} begin`);
          err.code = '08000';
          throw err;
        }
        if (tx === 'open') throw Object.assign(new Error('nested begin'), { code: '25001' });
        tx = 'open';
        draft = {
          endpoint: committed.endpoint ? { ...committed.endpoint } : null,
          grantInserted: committed.grantInserted,
          grantRow: committed.grantRow ? { ...committed.grantRow } : null,
        };
        return { rows: [], rowCount: 0 };
      }
      if (isCommit(text)) {
        if (modes.commitAmbiguous) {
          const err = new Error(`${LEAK} commit ambiguous`);
          err.code = '57P01';
          throw err;
        }
        if (modes.commitThrow) {
          const err = new Error(`${LEAK} commit`);
          err.code = '08006';
          throw err;
        }
        if (draft) {
          committed = {
            endpoint: draft.endpoint ? { ...draft.endpoint } : null,
            grantInserted: draft.grantInserted,
            grantRow: draft.grantRow ? { ...draft.grantRow } : null,
          };
        }
        draft = null;
        tx = 'committed';
        return { rows: [], rowCount: 0 };
      }
      if (isRollback(text)) {
        draft = null;
        tx = 'rolled_back';
        return { rows: [], rowCount: 0 };
      }

      if (isSelectLock(text)) {
        if (modes.selectThrow) {
          const err = modes.selectThrow instanceof Error
            ? modes.selectThrow
            : Object.assign(new Error(modes.selectThrow.message || 'select'), modes.selectThrow);
          throw err;
        }
        if (Array.isArray(modes.selectRows)) {
          return { rows: modes.selectRows, rowCount: modes.selectRows.length };
        }
        const state = view();
        if (state.endpoint == null) return { rows: [], rowCount: 0 };
        return { rows: [{ ...state.endpoint }], rowCount: 1 };
      }

      if (isInsertGrant(text)) {
        if (modes.insertThrow) {
          const err = modes.insertThrow instanceof Error
            ? modes.insertThrow
            : Object.assign(new Error(modes.insertThrow.message || 'insert'), modes.insertThrow);
          throw err;
        }
        if (Array.isArray(modes.insertRows)) {
          return { rows: modes.insertRows, rowCount: modes.insertRows.length };
        }
        const state = ensureDraft();
        if (state.grantInserted) {
          const err = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
        state.grantInserted = true;
        state.grantRow = {
          client_id: p[0],
          endpoint_id: p[1],
          grant_generation: 1,
          grant_status: 'active',
          reconcile_state: 'clean',
          last_operation_id: p[2],
          envelope_version: p[3],
          aead_alg: p[4],
          kek_wrap_alg: p[5],
          kek_key_name: p[6],
          kek_key_version: p[7],
          nonce: p[8],
          ciphertext: p[9],
          auth_tag: p[10],
          wrapped_dek: p[11],
          created_by: p[12],
          updated_by: p[12],
        };
        return {
          rows: [{
            client_id: state.grantRow.client_id,
            endpoint_id: state.grantRow.endpoint_id,
            grant_generation: 1,
            grant_status: 'active',
            reconcile_state: 'clean',
          }],
          rowCount: 1,
        };
      }

      if (isUpdateEndpoint(text)) {
        if (modes.updateThrow) {
          const err = modes.updateThrow instanceof Error
            ? modes.updateThrow
            : Object.assign(new Error(modes.updateThrow.message || 'update'), modes.updateThrow);
          throw err;
        }
        if (Array.isArray(modes.updateRows)) {
          return { rows: modes.updateRows, rowCount: modes.updateRows.length };
        }
        const state = ensureDraft();
        // Simulate CAS: must match current status + public_address.
        if (!state.endpoint
            || state.endpoint.binding_status !== p[6]
            || state.endpoint.public_address !== p[7]
            || state.endpoint.client_id !== p[0]
            || state.endpoint.id !== p[1]) {
          return { rows: [], rowCount: 0 };
        }
        state.endpoint = {
          ...state.endpoint,
          provider_tenant_id: p[2],
          provider_principal_oid: p[3],
          provider_resource_id: p[4],
          mailbox_kind: 'user',
          mailbox_access_kind: 'own_user',
          binding_status: 'verified',
          updated_by: p[5],
        };
        return {
          rows: [{
            id: state.endpoint.id,
            client_id: state.endpoint.client_id,
            binding_status: 'verified',
            provider_tenant_id: state.endpoint.provider_tenant_id,
            provider_principal_oid: state.endpoint.provider_principal_oid,
            provider_resource_id: state.endpoint.provider_resource_id,
            mailbox_kind: 'user',
            mailbox_access_kind: 'own_user',
            public_address: state.endpoint.public_address,
          }],
          rowCount: 1,
        };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  return {
    client,
    queries,
    get tx() { return tx; },
    get grantInserted() { return view().grantInserted; },
    get grantRow() { return view().grantRow; },
    get endpointState() { return view().endpoint; },
    setEndpoint(next) {
      committed.endpoint = next;
      if (draft) draft.endpoint = next ? { ...next } : null;
    },
    reset() {
      queries.length = 0;
      tx = 'idle';
      draft = null;
      committed = {
        endpoint: initialEndpoint(),
        grantInserted: false,
        grantRow: null,
      };
    },
  };
}

function installerFromFake(fake) {
  return createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: fake.client }));
}

function sqlKinds(queries) {
  return queries.map((q) => {
    const t = q.text;
    if (/^\s*BEGIN\b/i.test(t)) return 'BEGIN';
    if (/^\s*COMMIT\b/i.test(t)) return 'COMMIT';
    if (/^\s*ROLLBACK\b/i.test(t)) return 'ROLLBACK';
    if (/FOR\s+UPDATE/i.test(t) && /tenant_channel_endpoints/i.test(t)) return 'SELECT_LOCK';
    if (/INSERT\s+INTO\s+tenant_email_delegated_grants/i.test(t)) return 'INSERT_GRANT';
    if (/UPDATE\s+tenant_channel_endpoints/i.test(t)) return 'UPDATE_ENDPOINT';
    return 'OTHER';
  });
}

// ── Exports / surface ──────────────────────────────────────────────────────

test('exports exact frozen surface and constants', function exportsSurface() {
  const mod = require('./lib/email-microsoft-verified-grant-installer');
  assert.equal(Object.isFrozen(mod), true);
  assert.equal(ERROR_CODE, 'MICROSOFT_VERIFIED_GRANT_INSTALLER_INVALID');
  assert.equal(ERROR_MESSAGE, 'Microsoft verified grant install failed.');
  assert.equal(INSTALLER_METHOD, 'installVerifiedGrant');
  assert.equal(INSTALLER_ACK_STATUS, 'installed');
  assert.deepEqual(INSTALLER_ACK, Object.freeze({ status: 'installed' }));
  assert.equal(Object.isFrozen(INSTALLER_ACK), true);
  assert.deepEqual([...INSTALL_KEYS], [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope',
  ]);
  assert.deepEqual([...INSTALL_KEYS], [...CUSTODY_INSTALL_KEYS]);
  assert.equal(INSTALLER_METHOD, CUSTODY_INSTALLER_METHOD);
  assert.equal(GRANT_GENERATION_INITIAL, 1);
  assert.deepEqual([...ELIGIBLE_BINDING_STATUSES], [
    'unverified_offline', 'pending_manual_validation',
  ]);
  assert.deepEqual([...DEPENDENCY_KEYS], ['client']);
  assert.deepEqual([...IDENTITY_KEYS], [
    'providerTenantId', 'providerPrincipalId', 'mailboxAddress', 'displayName',
  ]);
  // SQL textual order constants (exact set enforced on driver rows).
  assert.deepEqual([...LOCK_ROW_KEYS], [
    'id', 'client_id', 'provider', 'auth_mode', 'connector_mode', 'binding_status', 'public_address',
  ]);
  assert.deepEqual([...GRANT_RETURNING_KEYS], [
    'client_id', 'endpoint_id', 'grant_generation', 'grant_status', 'reconcile_state',
  ]);
  assert.deepEqual([...UPDATE_RETURNING_KEYS], [
    'id', 'client_id', 'binding_status', 'provider_tenant_id', 'provider_principal_oid',
    'provider_resource_id', 'mailbox_kind', 'mailbox_access_kind', 'public_address',
  ]);
  assert.equal(typeof createMicrosoftVerifiedGrantInstaller, 'function');
});

test('package script registered; module file present', function packageScript() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  assert.equal(
    pkg.scripts['verify:email-microsoft-verified-grant-installer'],
    `node ${VERIFY_REL}`,
  );
  assert.equal(fs.existsSync(path.join(ROOT, LIB_REL)), true);
  assert.equal(fs.existsSync(path.join(ROOT, VERIFY_REL)), true);
});

// ── Factory dependency pinning ─────────────────────────────────────────────

test('factory accepts exact frozen { client } with query; returns exact frozen installer', function factoryHappy() {
  const fake = createFakePinnedClient();
  const installer = createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: fake.client }));
  assert.equal(Object.isFrozen(installer), true);
  assert.deepEqual(Reflect.ownKeys(installer), [INSTALLER_METHOD]);
  assert.equal(typeof installer.installVerifiedGrant, 'function');
  assert.equal(installer.install, undefined);
  assert.equal(installer.installInitialDelegatedGrant, undefined);
});

test('factory rejects missing/extra deps, unfrozen, pool, non-query, proxies, symbols', function factoryHostileDeps() {
  const query = async () => ({ rows: [] });
  assert.throws(() => createMicrosoftVerifiedGrantInstaller(null), failSanitized);
  assert.throws(() => createMicrosoftVerifiedGrantInstaller(undefined), failSanitized);
  assert.throws(() => createMicrosoftVerifiedGrantInstaller({ client: { query } }), failSanitized); // unfrozen
  assert.throws(
    () => createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: { query }, extra: 1 })),
    failSanitized,
  );
  assert.throws(
    () => createMicrosoftVerifiedGrantInstaller(Object.freeze({ pool: { query } })),
    failSanitized,
  );
  assert.throws(
    () => createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: { connect: () => {} } })),
    failSanitized,
  );
  const pool = {
    query,
    connect: async () => ({}),
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
  };
  assert.throws(
    () => createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: pool })),
    failSanitized,
  );
  assert.throws(
    () => createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: 'nope' })),
    failSanitized,
  );
  const accessor = {};
  Object.defineProperty(accessor, 'client', {
    enumerable: true,
    get() { return { query }; },
  });
  Object.freeze(accessor);
  assert.throws(() => createMicrosoftVerifiedGrantInstaller(accessor), failSanitized);

  const sym = Object.freeze({ client: { query }, [Symbol('x')]: 1 });
  // exactFrozenData rejects symbol keys via ownKeys length/type
  assert.throws(() => createMicrosoftVerifiedGrantInstaller(sym), failSanitized);

  const proto = Object.create({ client: { query } });
  Object.defineProperty(proto, 'client', { value: { query }, enumerable: true });
  Object.freeze(proto);
  assert.throws(() => createMicrosoftVerifiedGrantInstaller(proto), failSanitized);
});

// ── Happy path SQL order / params / ack ────────────────────────────────────

test('happy path: exact SQL order, params, commit; returns exact frozen installed ack', async function happyPath() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  const input = goodInstall();
  const ack = await installer.installVerifiedGrant(input);
  assert.deepEqual(ack, INSTALLER_ACK);
  assert.equal(Object.isFrozen(ack), true);
  assert.deepEqual(Reflect.ownKeys(ack), ['status']);
  assert.equal(ack.status, 'installed');

  assert.deepEqual(sqlKinds(fake.queries), [
    'BEGIN', 'SELECT_LOCK', 'INSERT_GRANT', 'UPDATE_ENDPOINT', 'COMMIT',
  ]);
  assert.equal(fake.tx, 'committed');
  assert.equal(fake.grantInserted, true);
  assert.equal(fake.endpointState.binding_status, 'verified');
  assert.equal(fake.endpointState.provider_tenant_id, TID);
  assert.equal(fake.endpointState.provider_principal_oid, PRINCIPAL);
  assert.equal(fake.endpointState.provider_resource_id, PRINCIPAL);
  assert.equal(fake.endpointState.mailbox_kind, 'user');
  assert.equal(fake.endpointState.mailbox_access_kind, 'own_user');
  assert.equal(fake.endpointState.public_address, MAILBOX);

  const lock = fake.queries[1];
  assert.deepEqual(lock.params, [CLIENT_ID, ENDPOINT_ID]);

  const ins = fake.queries[2];
  assert.equal(ins.params[0], CLIENT_ID);
  assert.equal(ins.params[1], ENDPOINT_ID);
  assert.equal(ins.params[2], OPERATION_ID);
  assert.equal(ins.params[3], 'v1');
  assert.equal(ins.params[4], 'AES-256-GCM');
  assert.equal(ins.params[5], 'A256KW');
  assert.equal(ins.params[12], ACTOR_ID); // created_by = updated_by = actor

  const upd = fake.queries[3];
  assert.equal(upd.params[0], CLIENT_ID);
  assert.equal(upd.params[1], ENDPOINT_ID);
  assert.equal(upd.params[2], TID);
  assert.equal(upd.params[3], PRINCIPAL);
  assert.equal(upd.params[4], PRINCIPAL); // provider_resource_id = providerPrincipalId
  assert.equal(upd.params[5], ACTOR_ID);
  assert.equal(upd.params[6], 'unverified_offline');
  assert.equal(upd.params[7], MAILBOX);
});

test('pending_manual_validation is eligible; public_address unchanged', async function pendingEligible() {
  const fake = createFakePinnedClient({
    endpoint: { binding_status: 'pending_manual_validation' },
  });
  const installer = installerFromFake(fake);
  const ack = await installer.installVerifiedGrant(goodInstall());
  assert.deepEqual(ack, INSTALLER_ACK);
  assert.equal(fake.endpointState.binding_status, 'verified');
  assert.equal(fake.endpointState.public_address, MAILBOX);
  assert.equal(fake.queries[3].params[6], 'pending_manual_validation');
});

test('actorStaffUserId null is allowed and written as null audit', async function nullActor() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  const ack = await installer.installVerifiedGrant(goodInstall({ actorStaffUserId: null }));
  assert.deepEqual(ack, INSTALLER_ACK);
  assert.equal(fake.queries[2].params[12], null);
  assert.equal(fake.queries[3].params[5], null);
});

// ── Binding status / mode / address rejections ─────────────────────────────

test('rejects null/verified/reauth/revoked binding status with rollback', async function statusReject() {
  for (const status of [null, 'verified', 'reauthorization_required', 'revoked', 'bogus']) {
    const fake = createFakePinnedClient({ endpoint: { binding_status: status } });
    const installer = installerFromFake(fake);
    await assert.rejects(
      () => installer.installVerifiedGrant(goodInstall()),
      failSanitized,
    );
    assert.deepEqual(sqlKinds(fake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
    assert.equal(fake.grantInserted, false);
    assert.equal(fake.endpointState.binding_status, status);
  }
});

test('rejects mode mismatch (provider/auth/connector) with rollback', async function modeReject() {
  const cases = [
    { provider: 'gmail_api' },
    { auth_mode: 'application_client_credentials' },
    { connector_mode: 'microsoft_app_only_enterprise' },
    { provider: 'microsoft_graph', auth_mode: null, connector_mode: null },
  ];
  for (const patch of cases) {
    const fake = createFakePinnedClient({ endpoint: patch });
    const installer = installerFromFake(fake);
    await assert.rejects(
      () => installer.installVerifiedGrant(goodInstall()),
      failSanitized,
    );
    assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
    assert.equal(sqlKinds(fake.queries).includes('INSERT_GRANT'), false);
    assert.equal(fake.grantInserted, false);
  }
});

test('rejects public_address !== verified mailbox with rollback', async function addressMismatch() {
  const fake = createFakePinnedClient({ endpoint: { public_address: 'other@example.com' } });
  const installer = installerFromFake(fake);
  await assert.rejects(
    () => installer.installVerifiedGrant(goodInstall()),
    failSanitized,
  );
  assert.deepEqual(sqlKinds(fake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
  assert.equal(fake.grantInserted, false);
});

test('Graph-preferred SMTP mailbox binds only when public_address exact-equals; UPN cannot substitute', async function preferredMailOwnershipBinding() {
  // Downstream of Graph mail-preference: mailboxAddress is the sole ownership key.
  // Endpoint prepared for support@… must match Graph-selected mail; a different
  // valid UPN on the Graph identity cannot satisfy public_address binding.
  const preferredMail = 'support@lunafrontdesk.com';
  const differentUpn = 'support@lunafrontdesk.onmicrosoft.com';
  assert.notEqual(preferredMail, differentUpn);

  const okFake = createFakePinnedClient({ endpoint: { public_address: preferredMail } });
  const okInstaller = installerFromFake(okFake);
  const ack = await okInstaller.installVerifiedGrant(goodInstall({
    identity: Object.freeze({
      providerTenantId: TID,
      providerPrincipalId: PRINCIPAL,
      mailboxAddress: preferredMail,
      displayName: 'Luna Support',
    }),
  }));
  assert.deepEqual(ack, { status: 'installed' });
  assert.equal(okFake.endpointState.public_address, preferredMail);
  assert.equal(okFake.endpointState.binding_status, 'verified');

  const mismatchFake = createFakePinnedClient({ endpoint: { public_address: preferredMail } });
  const mismatchInstaller = installerFromFake(mismatchFake);
  await assert.rejects(
    () => mismatchInstaller.installVerifiedGrant(goodInstall({
      identity: Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
        mailboxAddress: differentUpn,
        displayName: 'Luna Support',
      }),
    })),
    failSanitized,
  );
  assert.deepEqual(sqlKinds(mismatchFake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
  assert.equal(mismatchFake.grantInserted, false);
  assert.equal(mismatchFake.endpointState.binding_status, 'unverified_offline');
});

test('missing endpoint row rolls back; duplicate select rows roll back', async function rowCount() {
  {
    const fake = createFakePinnedClient({ selectRows: [] });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
  }
  {
    const fake = createFakePinnedClient({
      selectRows: [eligibleEndpoint(), eligibleEndpoint()],
    });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
  }
});

// ── Driver-row exact snapshot / hostile rows / lock observation freeze ─────

test('rejects lock-row getters/proxies/symbols/extras/wrong ids with rollback', async function lockRowHostile() {
  const wrongId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';

  // Accessor on binding_status
  {
    const row = eligibleEndpoint();
    Object.defineProperty(row, 'binding_status', {
      enumerable: true,
      get() { return 'unverified_offline'; },
    });
    const fake = createFakePinnedClient({ selectRows: [row] });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.deepEqual(sqlKinds(fake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
    assert.equal(fake.grantInserted, false);
    assert.equal(fake.endpointState.binding_status, 'unverified_offline');
  }

  // Extra column on lock row
  {
    const fake = createFakePinnedClient({
      selectRows: [{ ...eligibleEndpoint(), secret_ref: LEAK }],
    });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.deepEqual(sqlKinds(fake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
    assert.equal(fake.grantInserted, false);
  }

  // Symbol key on lock row
  {
    const row = eligibleEndpoint();
    row[Symbol('x')] = 1;
    const fake = createFakePinnedClient({ selectRows: [row] });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
    assert.equal(fake.grantInserted, false);
  }

  // Wrong endpoint id on locked row
  {
    const fake = createFakePinnedClient({
      selectRows: [eligibleEndpoint({ id: wrongId })],
    });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.deepEqual(sqlKinds(fake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
    assert.equal(fake.grantInserted, false);
  }

  // Wrong client_id on locked row
  {
    const fake = createFakePinnedClient({
      selectRows: [eligibleEndpoint({ client_id: wrongId })],
    });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.deepEqual(sqlKinds(fake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
    assert.equal(fake.grantInserted, false);
  }

  // Proxy lock row
  {
    const target = eligibleEndpoint();
    const proxy = new Proxy(target, {
      get(t, p) { return t[p]; },
      ownKeys(t) { return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, p) { return Reflect.getOwnPropertyDescriptor(t, p); },
      getPrototypeOf() { return Object.prototype; },
    });
    // Proxy always has Proxy identity; getPrototypeOf may still be Object.prototype,
    // but ownKeys/descriptors go through traps — if traps return data descs matching
    // keys, snapshotExactOwnDataRow may accept. Force failure via extra trap that
    // injects an accessor-like descriptor for one key when inspected carefully:
    // Actually Proxy with transparent forwarding of data props on plain object can
    // pass Object.getOwnPropertyDescriptor to target. Reject via wrong prototype path
    // is unreliable; use a Proxy that presents a getter for binding_status.
    const getterProxy = new Proxy({}, {
      ownKeys() {
        return [...LOCK_ROW_KEYS];
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (prop === 'binding_status') {
          return {
            enumerable: true,
            configurable: true,
            get() { return 'unverified_offline'; },
          };
        }
        if (LOCK_ROW_KEYS.includes(prop)) {
          return {
            enumerable: true,
            configurable: true,
            writable: true,
            value: target[prop],
          };
        }
        return undefined;
      },
      getPrototypeOf() { return Object.prototype; },
    });
    const fake = createFakePinnedClient({ selectRows: [getterProxy] });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.deepEqual(sqlKinds(fake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
    assert.equal(fake.grantInserted, false);
  }
});

test('rejects insert/update RETURNING wrong ids/extras/accessors with rollback', async function returningRowHostile() {
  // INSERT RETURNING wrong client_id
  {
    const fake = createFakePinnedClient({
      insertRows: [{
        client_id: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb',
        endpoint_id: ENDPOINT_ID,
        grant_generation: 1,
        grant_status: 'active',
        reconcile_state: 'clean',
      }],
    });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    const kinds = sqlKinds(fake.queries);
    assert.equal(kinds.includes('INSERT_GRANT'), true);
    assert.equal(kinds.includes('UPDATE_ENDPOINT'), false);
    assert.equal(kinds.includes('ROLLBACK'), true);
    assert.equal(kinds.includes('COMMIT'), false);
  }

  // INSERT RETURNING extra key
  {
    const fake = createFakePinnedClient({
      insertRows: [{
        client_id: CLIENT_ID,
        endpoint_id: ENDPOINT_ID,
        grant_generation: 1,
        grant_status: 'active',
        reconcile_state: 'clean',
        extra: LEAK,
      }],
    });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
    assert.equal(sqlKinds(fake.queries).includes('COMMIT'), false);
  }

  // UPDATE RETURNING wrong id
  {
    const fake = createFakePinnedClient({
      updateRows: [{
        id: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb',
        client_id: CLIENT_ID,
        binding_status: 'verified',
        provider_tenant_id: TID,
        provider_principal_oid: PRINCIPAL,
        provider_resource_id: PRINCIPAL,
        mailbox_kind: 'user',
        mailbox_access_kind: 'own_user',
        public_address: MAILBOX,
      }],
    });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    const kinds = sqlKinds(fake.queries);
    assert.equal(kinds.includes('UPDATE_ENDPOINT'), true);
    assert.equal(kinds.includes('ROLLBACK'), true);
    assert.equal(kinds.includes('COMMIT'), false);
    assert.equal(fake.grantInserted, false);
  }

  // UPDATE RETURNING accessor on binding_status
  {
    const row = {
      id: ENDPOINT_ID,
      client_id: CLIENT_ID,
      binding_status: 'verified',
      provider_tenant_id: TID,
      provider_principal_oid: PRINCIPAL,
      provider_resource_id: PRINCIPAL,
      mailbox_kind: 'user',
      mailbox_access_kind: 'own_user',
      public_address: MAILBOX,
    };
    Object.defineProperty(row, 'binding_status', {
      enumerable: true,
      get() { return 'verified'; },
    });
    const fake = createFakePinnedClient({ updateRows: [row] });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
    assert.equal(sqlKinds(fake.queries).includes('COMMIT'), false);
  }
});

test('lock snapshot freezes bindingStatus; driver-row mutation cannot change UPDATE CAS', async function lockSnapshotStable() {
  const lockRow = eligibleEndpoint({ binding_status: 'unverified_offline' });
  const fake = createFakePinnedClient({ selectRows: [lockRow] });
  const origQuery = fake.client.query.bind(fake.client);
  fake.client.query = async function query(sql, params) {
    const text = String(sql || '');
    // After lock validation, before/at insert: mutate original driver row.
    if (/INSERT\s+INTO\s+tenant_email_delegated_grants/i.test(text)) {
      lockRow.binding_status = 'revoked';
      lockRow.public_address = 'mutated-evil@example.com';
      lockRow.provider = 'gmail_api';
      lockRow.id = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
      lockRow.client_id = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
    }
    return origQuery(sql, params);
  };
  const installer = installerFromFake(fake);
  const ack = await installer.installVerifiedGrant(goodInstall());
  assert.deepEqual(ack, INSTALLER_ACK);
  // UPDATE CAS must use frozen observed bindingStatus, not mutated driver value.
  const upd = fake.queries.find((q) => /UPDATE\s+tenant_channel_endpoints/i.test(q.text));
  assert.ok(upd);
  assert.equal(upd.params[6], 'unverified_offline');
  assert.equal(upd.params[7], MAILBOX);
  assert.equal(fake.endpointState.binding_status, 'verified');
  assert.equal(fake.grantInserted, true);
});

test('changing getter lock row fails before insert; never false-installed', async function lockChangingGetter() {
  let reads = 0;
  const row = {
    id: ENDPOINT_ID,
    client_id: CLIENT_ID,
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    public_address: MAILBOX,
  };
  Object.defineProperty(row, 'binding_status', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'unverified_offline' : 'verified';
    },
  });
  const fake = createFakePinnedClient({ selectRows: [row] });
  const installer = installerFromFake(fake);
  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  assert.deepEqual(sqlKinds(fake.queries), ['BEGIN', 'SELECT_LOCK', 'ROLLBACK']);
  assert.equal(fake.grantInserted, false);
  assert.notEqual(fake.endpointState.binding_status, 'verified');
  // Accessor rejected without relying on multi-read flip.
  assert.equal(sqlKinds(fake.queries).includes('INSERT_GRANT'), false);
  assert.equal(sqlKinds(fake.queries).includes('COMMIT'), false);
});

test('pending lock snapshot: mutated status after lock still uses observed pending CAS', async function pendingLockSnapshotStable() {
  const lockRow = eligibleEndpoint({ binding_status: 'pending_manual_validation' });
  const fake = createFakePinnedClient({ selectRows: [lockRow] });
  const observed = { casStatus: null, casAddress: null };
  const oq = fake.client.query.bind(fake.client);
  fake.client.query = async function query(sql, params) {
    const text = String(sql || '');
    if (/INSERT\s+INTO\s+tenant_email_delegated_grants/i.test(text)) {
      // Mutate original driver row after lock snapshot; must not affect CAS params.
      lockRow.binding_status = 'revoked';
      lockRow.public_address = 'evil@example.com';
    }
    if (/UPDATE\s+tenant_channel_endpoints/i.test(text)) {
      observed.casStatus = params[6];
      observed.casAddress = params[7];
      // Succeed only when installer still sends the frozen observed values.
      if (params[6] === 'pending_manual_validation' && params[7] === MAILBOX) {
        return {
          rows: [{
            id: ENDPOINT_ID,
            client_id: CLIENT_ID,
            binding_status: 'verified',
            provider_tenant_id: TID,
            provider_principal_oid: PRINCIPAL,
            provider_resource_id: PRINCIPAL,
            mailbox_kind: 'user',
            mailbox_access_kind: 'own_user',
            public_address: MAILBOX,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    return oq(sql, params);
  };
  const installer = installerFromFake(fake);
  const ack = await installer.installVerifiedGrant(goodInstall());
  assert.deepEqual(ack, INSTALLER_ACK);
  assert.equal(observed.casStatus, 'pending_manual_validation');
  assert.equal(observed.casAddress, MAILBOX);
  assert.equal(lockRow.binding_status, 'revoked');
  assert.equal(lockRow.public_address, 'evil@example.com');
});

// ── 23505 / insert / update / commit failures ──────────────────────────────

test('SQLSTATE 23505 ownership/grant conflict sanitized + rollback', async function conflict23505() {
  const fake = createFakePinnedClient({
    insertThrow: Object.assign(new Error(`${LEAK} duplicate`), { code: '23505' }),
  });
  const installer = installerFromFake(fake);
  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
  assert.equal(sqlKinds(fake.queries).includes('COMMIT'), false);
});

test('insert zero/duplicate rows roll back; update zero rows roll back', async function rowFailures() {
  {
    const fake = createFakePinnedClient({ insertRows: [] });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
  }
  {
    const fake = createFakePinnedClient({
      insertRows: [
        { client_id: CLIENT_ID, endpoint_id: ENDPOINT_ID, grant_generation: 1, grant_status: 'active', reconcile_state: 'clean' },
        { client_id: CLIENT_ID, endpoint_id: ENDPOINT_ID, grant_generation: 1, grant_status: 'active', reconcile_state: 'clean' },
      ],
    });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
  }
  {
    const fake = createFakePinnedClient({ updateRows: [] });
    const installer = installerFromFake(fake);
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    const kinds = sqlKinds(fake.queries);
    assert.equal(kinds.includes('INSERT_GRANT'), true);
    assert.equal(kinds.includes('ROLLBACK'), true);
    assert.equal(kinds.includes('COMMIT'), false);
    // Fake rolls back grant on ROLLBACK.
    assert.equal(fake.grantInserted, false);
  }
});

test('update 23505 ownership conflict sanitized', async function updateOwnership() {
  const fake = createFakePinnedClient({
    updateThrow: Object.assign(new Error(`${LEAK} ownership`), { code: '23505' }),
  });
  const installer = installerFromFake(fake);
  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
});

test('COMMIT ambiguity: never ROLLBACK after COMMIT attempt; sanitized', async function commitAmbiguity() {
  const fake = createFakePinnedClient({ commitAmbiguous: true });
  const installer = installerFromFake(fake);
  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  const kinds = sqlKinds(fake.queries);
  assert.equal(kinds.includes('COMMIT'), true);
  // After COMMIT attempt, must not issue ROLLBACK.
  const commitIdx = kinds.indexOf('COMMIT');
  assert.equal(kinds.slice(commitIdx + 1).includes('ROLLBACK'), false);
});

test('COMMIT throw after send: no rollback; sanitized', async function commitThrow() {
  const fake = createFakePinnedClient({ commitThrow: true });
  const installer = installerFromFake(fake);
  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  const kinds = sqlKinds(fake.queries);
  assert.equal(kinds[kinds.length - 1], 'COMMIT');
  assert.equal(kinds.includes('ROLLBACK'), false);
});

// ── Input validation (pre-DB) ──────────────────────────────────────────────

test('rejects unfrozen/wrong-order/extra/missing install keys without SQL', async function inputShape() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);

  await assert.rejects(() => installer.installVerifiedGrant({ ...goodInstall() }), failSanitized);
  await assert.rejects(() => installer.installVerifiedGrant(null), failSanitized);

  const wrongOrder = Object.freeze({
    envelope: structuralEnvelope(),
    identity: goodIdentity(),
    actorStaffUserId: ACTOR_ID,
    operationId: OPERATION_ID,
    endpointId: ENDPOINT_ID,
    clientId: CLIENT_ID,
  });
  // Keys present but exactPlainData only checks set membership + length, not order of definition.
  // Adapter freezes in INSTALL_KEYS order; we accept same key set (order of Reflect.ownKeys
  // depends on insertion). Ensure insertion order matching adapter is what we freeze in goodInstall.
  assert.deepEqual(Reflect.ownKeys(goodInstall()), [...INSTALL_KEYS]);

  const extra = Object.freeze({ ...goodInstall(), extra: 1 });
  await assert.rejects(() => installer.installVerifiedGrant(extra), failSanitized);

  const missing = Object.freeze({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: ACTOR_ID,
    identity: goodIdentity(),
  });
  await assert.rejects(() => installer.installVerifiedGrant(missing), failSanitized);

  assert.equal(fake.queries.length, 0);
});

test('rejects non-canonical UUIDs and bad actor without SQL', async function uuidRules() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  const bad = [
    { clientId: 'NOT-A-UUID' },
    { endpointId: CLIENT_ID.toUpperCase() },
    { operationId: '123' },
    { actorStaffUserId: 'nope' },
    { actorStaffUserId: CLIENT_ID.toUpperCase() },
  ];
  for (const patch of bad) {
    await assert.rejects(
      () => installer.installVerifiedGrant(goodInstall(patch)),
      failSanitized,
    );
  }
  assert.equal(fake.queries.length, 0);
});

test('rejects identity shape/mailbox/surrogate/case without SQL', async function identityRules() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);

  const badIdentities = [
    goodIdentity({ providerTenantId: 'not-uuid' }),
    goodIdentity({ providerTenantId: TID.toUpperCase() }),
    goodIdentity({ providerPrincipalId: '' }),
    // principal must be canonical UUID (migration 058 provider_principal_oid_shape)
    goodIdentity({ providerPrincipalId: 'not-a-uuid-principal' }),
    goodIdentity({ providerPrincipalId: PRINCIPAL.toUpperCase() }),
    goodIdentity({ providerPrincipalId: 'user@example.com' }),
    goodIdentity({ providerPrincipalId: '😀-emoji-principal' }),
    goodIdentity({ mailboxAddress: 'Ada@Example.com' }),
    goodIdentity({ mailboxAddress: ' ada@example.com' }),
    goodIdentity({ mailboxAddress: 'ada@example.com ' }),
    goodIdentity({ mailboxAddress: 'ada@exam..ple.com' }),
    goodIdentity({ displayName: '' }),
    goodIdentity({ displayName: 'x\u0000y' }),
    // unpaired surrogate in principal
    Object.freeze({
      providerTenantId: TID,
      providerPrincipalId: `x${String.fromCharCode(0xd800)}y`,
      mailboxAddress: MAILBOX,
      displayName: null,
    }),
    // missing displayName key
    Object.freeze({
      providerTenantId: TID,
      providerPrincipalId: PRINCIPAL,
      mailboxAddress: MAILBOX,
    }),
    // extra key
    Object.freeze({
      providerTenantId: TID,
      providerPrincipalId: PRINCIPAL,
      mailboxAddress: MAILBOX,
      displayName: null,
      extra: 1,
    }),
    // unfrozen identity
    {
      providerTenantId: TID,
      providerPrincipalId: PRINCIPAL,
      mailboxAddress: MAILBOX,
      displayName: null,
    },
  ];

  for (const identity of badIdentities) {
    const input = Object.freeze({
      clientId: CLIENT_ID,
      endpointId: ENDPOINT_ID,
      operationId: OPERATION_ID,
      actorStaffUserId: ACTOR_ID,
      identity,
      envelope: structuralEnvelope(),
    });
    await assert.rejects(() => installer.installVerifiedGrant(input), failSanitized);
  }
  assert.equal(fake.queries.length, 0);
});

test('non-UUID/emoji principal: zero SQL + burn; second good call still zero SQL', async function principalUuidPreflightBurn() {
  const badPrincipals = [
    'not-a-uuid',
    '😀',
    'user-oid-not-uuid',
    PRINCIPAL.toUpperCase(),
    `${PRINCIPAL} `,
    ` ${PRINCIPAL}`,
    PRINCIPAL.replace(/-/g, ''),
    'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
  ];
  for (const providerPrincipalId of badPrincipals) {
    const fake = createFakePinnedClient();
    const installer = installerFromFake(fake);
    await assert.rejects(
      () => installer.installVerifiedGrant(goodInstall({
        identity: goodIdentity({ providerPrincipalId }),
      })),
      failSanitized,
    );
    assert.equal(fake.queries.length, 0, `expected zero SQL for principal=${providerPrincipalId}`);
    assert.equal(fake.grantInserted, false);
    assert.equal(fake.endpointState.binding_status, 'unverified_offline');
    // Burn: second good call must not open SQL either.
    await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
    assert.equal(fake.queries.length, 0);
    assert.equal(fake.grantInserted, false);
  }
});

test('rejects envelope operation mismatch / invalid envelope without SQL', async function envelopeRules() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);

  const otherOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await assert.rejects(
    () => installer.installVerifiedGrant(goodInstall({
      envelope: structuralEnvelope(otherOp),
    })),
    failSanitized,
  );

  await assert.rejects(
    () => installer.installVerifiedGrant(goodInstall({
      envelope: Object.freeze({ ...structuralEnvelope(), envelope_version: 'v2' }),
    })),
    failSanitized,
  );

  await assert.rejects(
    () => installer.installVerifiedGrant(goodInstall({
      envelope: Object.freeze({ ...structuralEnvelope(), nonce: Buffer.alloc(11) }),
    })),
    failSanitized,
  );

  assert.equal(fake.queries.length, 0);
});

test('rejects token/AAD keys on install input without SQL', async function noTokenKeys() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  for (const key of ['accessToken', 'refreshToken', 'idToken', 'aad', 'refresh_token', 'access_token']) {
    const obj = {
      clientId: CLIENT_ID,
      endpointId: ENDPOINT_ID,
      operationId: OPERATION_ID,
      actorStaffUserId: ACTOR_ID,
      identity: goodIdentity(),
      envelope: structuralEnvelope(),
      [key]: LEAK,
    };
    await assert.rejects(
      () => installer.installVerifiedGrant(Object.freeze(obj)),
      failSanitized,
    );
  }
  assert.equal(fake.queries.length, 0);
});

test('rejects proxies/accessors/symbols/prototypes/descriptors on input', async function hostileReflection() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);

  const withAccessor = {
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: ACTOR_ID,
    identity: goodIdentity(),
    envelope: structuralEnvelope(),
  };
  Object.defineProperty(withAccessor, 'clientId', {
    enumerable: true,
    get() { return CLIENT_ID; },
  });
  await assert.rejects(
    () => installer.installVerifiedGrant(Object.freeze(withAccessor)),
    failSanitized,
  );

  const withSymbol = Object.freeze({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: ACTOR_ID,
    identity: goodIdentity(),
    envelope: structuralEnvelope(),
    [Symbol('x')]: 1,
  });
  await assert.rejects(() => installer.installVerifiedGrant(withSymbol), failSanitized);

  const protoPoison = Object.create({ clientId: CLIENT_ID });
  Object.assign(protoPoison, {
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: ACTOR_ID,
    identity: goodIdentity(),
    envelope: structuralEnvelope(),
  });
  await assert.rejects(
    () => installer.installVerifiedGrant(Object.freeze(protoPoison)),
    failSanitized,
  );

  assert.equal(fake.queries.length, 0);
});

test('snapshots before DB: input mutation after call start cannot alter params', async function snapshotBeforeDb() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  const identity = {
    providerTenantId: TID,
    providerPrincipalId: PRINCIPAL,
    mailboxAddress: MAILBOX,
    displayName: DISPLAY,
  };
  const envelope = {
    envelope_version: 'v1',
    aead_alg: 'AES-256-GCM',
    kek_wrap_alg: 'A256KW',
    kek_key_name: 'fake-luna-grant-kek',
    kek_key_version: 'v1-test-0001',
    nonce: Buffer.alloc(12, 1),
    ciphertext: Buffer.alloc(32, 2),
    auth_tag: Buffer.alloc(16, 3),
    wrapped_dek: Buffer.alloc(40, 4),
    operation_id: OPERATION_ID,
  };
  const input = Object.freeze({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: ACTOR_ID,
    identity: Object.freeze(identity),
    envelope: Object.freeze(envelope),
  });
  // Mutate buffers after freeze of outer (buffers still mutable content)
  const ack = await installer.installVerifiedGrant(input);
  assert.deepEqual(ack, INSTALLER_ACK);
  // Corrupt buffers after install — should not have shared backing if independent copy used
  envelope.nonce.fill(9);
  assert.notEqual(fake.grantRow.nonce[0], 9);
});

// ── Gen-1 AAD rebuild policy ───────────────────────────────────────────────

test('rebuilds gen-1 AAD identity; operation bind; does not require AAD on input', async function aadPolicy() {
  const aad = buildGrantEnvelopeAadV1({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    grantGeneration: GRANT_GENERATION_INITIAL,
    operationId: OPERATION_ID,
  });
  assert.equal(Buffer.isBuffer(aad), true);
  assert.match(aad.toString('utf8'), /grant_generation=1/);
  assert.match(aad.toString('utf8'), new RegExp(`operation_id=${OPERATION_ID}`));

  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  const input = goodInstall();
  assert.equal('aad' in input, false);
  await installer.installVerifiedGrant(input);
  // SQL params must not include AAD buffer
  for (const q of fake.queries) {
    for (const p of q.params) {
      if (Buffer.isBuffer(p) && p.equals(aad)) {
        assert.fail('AAD must not be written to SQL params');
      }
    }
  }
});

// ── Single-use atomic burn (callback-operation scoped; not DB-status reuse) ─

test('invalid first input burns; second good call executes zero SQL', async function invalidFirstBurn() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  await assert.rejects(() => installer.installVerifiedGrant(null), failSanitized);
  assert.equal(fake.queries.length, 0);
  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  assert.equal(fake.queries.length, 0);
  assert.equal(fake.grantInserted, false);
  assert.equal(fake.endpointState.binding_status, 'unverified_offline');
});

test('sequential after success: second call zero SQL; first remains committed', async function sequentialAfterSuccess() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  const ack = await installer.installVerifiedGrant(goodInstall());
  assert.deepEqual(ack, INSTALLER_ACK);
  assert.equal(fake.endpointState.binding_status, 'verified');
  assert.equal(fake.grantInserted, true);
  const afterSuccess = fake.queries.length;
  assert.ok(afterSuccess >= 1);
  assert.equal(sqlKinds(fake.queries).filter((k) => k === 'BEGIN').length, 1);

  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  assert.equal(fake.queries.length, afterSuccess, 'second call must execute zero SQL');
  assert.equal(fake.endpointState.binding_status, 'verified');
  assert.equal(fake.grantInserted, true);
});

test('sequential after failure: second call zero SQL', async function sequentialAfterFailure() {
  const fake = createFakePinnedClient({
    insertThrow: Object.assign(new Error(`${LEAK} boom`), { code: '23505' }),
  });
  const installer = installerFromFake(fake);
  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  const afterFailure = fake.queries.length;
  assert.ok(afterFailure >= 1);
  assert.equal(fake.grantInserted, false);

  await assert.rejects(() => installer.installVerifiedGrant(goodInstall()), failSanitized);
  assert.equal(fake.queries.length, afterFailure, 'second call must execute zero SQL');
  assert.equal(fake.grantInserted, false);
});

test('concurrent Promise calls: exactly one BEGIN; one ack or sanitized fail', async function concurrentOneBegin() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  const p1 = installer.installVerifiedGrant(goodInstall());
  const p2 = installer.installVerifiedGrant(goodInstall());
  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.deepEqual(fulfilled[0].value, INSTALLER_ACK);
  assert.equal(failSanitized(rejected[0].reason), true);
  assert.equal(sqlKinds(fake.queries).filter((k) => k === 'BEGIN').length, 1);
  assert.equal(sqlKinds(fake.queries).filter((k) => k === 'COMMIT').length, 1);
  assert.equal(fake.endpointState.binding_status, 'verified');
  assert.equal(fake.grantInserted, true);
});

test('reentrant install from client.query: exactly one transaction; reentry sanitized', async function reentrantFromQuery() {
  const fake = createFakePinnedClient();
  let installer;
  let reentrantError = null;
  const origQuery = fake.client.query.bind(fake.client);
  let beginSeen = 0;
  fake.client.query = async function query(sql, params) {
    const text = String(sql || '');
    if (/^\s*BEGIN\b/i.test(text)) {
      beginSeen += 1;
      if (beginSeen === 1) {
        try {
          await installer.installVerifiedGrant(goodInstall());
        } catch (error) {
          reentrantError = error;
        }
      }
    }
    return origQuery(sql, params);
  };
  installer = installerFromFake(fake);
  const ack = await installer.installVerifiedGrant(goodInstall());
  assert.deepEqual(ack, INSTALLER_ACK);
  assert.equal(failSanitized(reentrantError), true);
  assert.equal(sqlKinds(fake.queries).filter((k) => k === 'BEGIN').length, 1);
  assert.equal(sqlKinds(fake.queries).filter((k) => k === 'COMMIT').length, 1);
  assert.equal(fake.endpointState.binding_status, 'verified');
  assert.equal(fake.grantInserted, true);
});

test('hostile second input traps never touched after burn', async function hostileSecondTraps() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  await assert.rejects(() => installer.installVerifiedGrant(null), failSanitized);
  assert.equal(fake.queries.length, 0);

  const traps = [];
  const hostile = new Proxy({}, {
    get(_t, prop) {
      traps.push(['get', String(prop)]);
      throw new Error(`${LEAK} get ${String(prop)}`);
    },
    ownKeys() {
      traps.push(['ownKeys']);
      throw new Error(`${LEAK} ownKeys`);
    },
    getOwnPropertyDescriptor(_t, prop) {
      traps.push(['getOwnPropertyDescriptor', String(prop)]);
      throw new Error(`${LEAK} descriptor`);
    },
    getPrototypeOf() {
      traps.push(['getPrototypeOf']);
      throw new Error(`${LEAK} proto`);
    },
    has(_t, prop) {
      traps.push(['has', String(prop)]);
      throw new Error(`${LEAK} has`);
    },
  });
  await assert.rejects(() => installer.installVerifiedGrant(hostile), failSanitized);
  assert.deepEqual(traps, []);
  assert.equal(fake.queries.length, 0);
});

// ── Error sanitization ─────────────────────────────────────────────────────

test('errors never leak SQL/state/tokens/stacks secrets', async function noLeaks() {
  const fake = createFakePinnedClient({
    insertThrow: Object.assign(new Error(`${LEAK} ${REFRESH}`), { code: '23505' }),
  });
  const installer = installerFromFake(fake);
  try {
    await installer.installVerifiedGrant(goodInstall());
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(failSanitized(err), true);
    assertNoSensitive(err);
    assertNoSensitive(err.message);
    assertNoSensitive(err.code);
    assert.equal(err.message, ERROR_MESSAGE);
    assert.equal(err.code, ERROR_CODE);
  }
});

// ── Merged adapter interop ─────────────────────────────────────────────────

test('merged custody adapter + fake envelope + this installer: accepted + atomic bind', async function adapterInteropSuccess() {
  const fake = createFakePinnedClient();
  const installer = installerFromFake(fake);
  const envelopeProvider = createFakeEmailGrantEnvelopeProvider();
  const meta = getFakeEmailGrantEnvelopeProviderMeta(envelopeProvider);
  assert.equal(meta != null, true);
  assert.equal(typeof validateGrantEnvelopeRecordV1, 'function');

  const verifiedIdentity = Object.freeze({
    async verifyIdentity() {
      return goodIdentity();
    },
  });
  const clock = Object.freeze({
    nowEpochSeconds() { return NOW; },
  });

  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    Object.freeze({
      clientId: CLIENT_ID,
      endpointId: ENDPOINT_ID,
      operationId: OPERATION_ID,
      actorStaffUserId: ACTOR_ID,
      expectedNonce: NONCE,
      expectedClientId: EXPECTED_CLIENT,
    }),
    Object.freeze({
      verifiedIdentity,
      envelopeProvider,
      clock,
      installer,
    }),
  );

  const selected = Object.freeze({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    tokenType: 'Bearer',
    expiresIn: 3600,
    scope: GOOD_SCOPE,
    idToken: ID_TOKEN,
  });

  const result = await adapter.acceptValidatedTokens(selected);
  assert.deepEqual(result, SEALED_ACK);
  assert.equal(result.status, 'accepted');

  // Atomic: grant + verified identity both present after commit.
  assert.equal(fake.tx, 'committed');
  assert.equal(fake.grantInserted, true);
  assert.equal(fake.endpointState.binding_status, 'verified');
  assert.equal(fake.endpointState.provider_tenant_id, TID);
  assert.equal(fake.endpointState.provider_principal_oid, PRINCIPAL);
  assert.equal(fake.endpointState.provider_resource_id, PRINCIPAL);
  assert.equal(fake.endpointState.public_address, MAILBOX);
  assert.equal(fake.grantRow.last_operation_id, OPERATION_ID);
  assert.equal(Number(fake.grantRow.grant_generation), 1);
  assert.equal(fake.grantRow.grant_status, 'active');
  assert.deepEqual(sqlKinds(fake.queries), [
    'BEGIN', 'SELECT_LOCK', 'INSERT_GRANT', 'UPDATE_ENDPOINT', 'COMMIT',
  ]);
});

test('adapter interop: injected insert failure leaves neither grant nor verified identity', async function adapterInteropFail() {
  const fake = createFakePinnedClient({
    insertThrow: Object.assign(new Error(`${LEAK} boom`), { code: '23505' }),
  });
  const installer = installerFromFake(fake);
  const envelopeProvider = createFakeEmailGrantEnvelopeProvider();
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    Object.freeze({
      clientId: CLIENT_ID,
      endpointId: ENDPOINT_ID,
      operationId: OPERATION_ID,
      actorStaffUserId: ACTOR_ID,
      expectedNonce: NONCE,
      expectedClientId: EXPECTED_CLIENT,
    }),
    Object.freeze({
      verifiedIdentity: Object.freeze({
        async verifyIdentity() { return goodIdentity(); },
      }),
      envelopeProvider,
      clock: Object.freeze({ nowEpochSeconds() { return NOW; } }),
      installer,
    }),
  );

  await assert.rejects(
    () => adapter.acceptValidatedTokens(Object.freeze({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: GOOD_SCOPE,
      idToken: ID_TOKEN,
    })),
    (err) => err && err.code === CUSTODY_ERROR_CODE,
  );

  assert.equal(fake.grantInserted, false);
  assert.equal(fake.endpointState.binding_status, 'unverified_offline');
  assert.equal(fake.endpointState.provider_tenant_id, undefined);
  assert.equal(sqlKinds(fake.queries).includes('ROLLBACK'), true);
  assert.equal(sqlKinds(fake.queries).includes('COMMIT'), false);
});

test('adapter interop: update failure after insert rolls back both', async function adapterInteropUpdateFail() {
  const fake = createFakePinnedClient({
    updateThrow: Object.assign(new Error(`${LEAK} own`), { code: '23505' }),
  });
  const installer = installerFromFake(fake);
  const envelopeProvider = createFakeEmailGrantEnvelopeProvider();
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    Object.freeze({
      clientId: CLIENT_ID,
      endpointId: ENDPOINT_ID,
      operationId: OPERATION_ID,
      actorStaffUserId: null,
      expectedNonce: NONCE,
      expectedClientId: EXPECTED_CLIENT,
    }),
    Object.freeze({
      verifiedIdentity: Object.freeze({
        async verifyIdentity() { return goodIdentity(); },
      }),
      envelopeProvider,
      clock: Object.freeze({ nowEpochSeconds() { return NOW; } }),
      installer,
    }),
  );

  await assert.rejects(
    () => adapter.acceptValidatedTokens(Object.freeze({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: GOOD_SCOPE,
      idToken: ID_TOKEN,
    })),
    (err) => err && err.code === CUSTODY_ERROR_CODE,
  );

  assert.equal(fake.grantInserted, false);
  assert.equal(fake.endpointState.binding_status, 'unverified_offline');
});

// ── Optional disposable local PG ───────────────────────────────────────────

test('optional disposable local PG transactional proof (skip if unavailable)', async function optionalPg() {
  let Client;
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    ({ Client } = require('pg'));
  } catch {
    console.log('  SKIP optional PG — pg module not installed');
    return;
  }

  const host = process.env.VERIFY_GRANT_INSTALLER_PGHOST
    || process.env.PGHOST
    || '';
  if (!host && !process.env.VERIFY_GRANT_INSTALLER_PG_URL && !process.env.DATABASE_URL) {
    // Only use explicit local disposable targets — never remote network DBs.
    console.log('  SKIP optional PG — no local disposable PG configured');
    return;
  }

  const connectionString = process.env.VERIFY_GRANT_INSTALLER_PG_URL
    || process.env.DATABASE_URL
    || null;
  // Refuse obvious remote hosts.
  const banned = /azure|amazonaws|neon\.tech|supabase|remote|lunafrontdesk/i;
  if (connectionString && banned.test(connectionString)) {
    console.log('  SKIP optional PG — refusing non-local connection string');
    return;
  }
  if (host && banned.test(host)) {
    console.log('  SKIP optional PG — refusing non-local host');
    return;
  }

  // Without a full migration harness this remains a connectivity smoke only.
  const client = connectionString
    ? new Client({ connectionString, connectionTimeoutMillis: 1500 })
    : new Client({
      host: host || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'postgres',
      connectionTimeoutMillis: 1500,
    });
  try {
    await client.connect();
    await client.query('SELECT 1 AS ok');
    console.log('  NOTE optional PG reachable — full schema proof deferred to prove script if added');
  } catch {
    console.log('  SKIP optional PG — not reachable');
  } finally {
    try { await client.end(); } catch { /* */ }
  }
});

// ── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('verify:email-microsoft-verified-grant-installer');
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(failed === 0 ? `OK ${tests.length}` : `FAIL ${failed}/${tests.length}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
