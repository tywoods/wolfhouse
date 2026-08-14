'use strict';

/**
 * verify:email-grant-envelope-azure-kv-provider — Slice 2F-B offline gate.
 *
 * Production Azure KV envelope provider core with injected RSA CryptographyClient
 * fake (local RSA keypair + real RSA-OAEP-256 wrap/unwrap). Independently decrypts
 * GCM. No network, no @azure SDK, no live Key Vault, no secrets, no Graph/routes.
 *
 * Covers: algorithm/key ID/call order; wrong AAD/key/version; unversioned/latest;
 * A256KW rejection; malformed SDK responses; planted Azure errors/429/auth/timeout;
 * hostile config/envelope/nested/client/response; zeroization where observable;
 * exact provider shape; static no SecretClient/setSecret/DefaultAzureCredential/
 * KeyClient/getKey/network/Graph/routes/activation.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const PROD_REL = 'scripts/lib/email-grant-envelope-azure-kv-provider.js';
const CONTRACT_REL = 'scripts/lib/email-grant-envelope-provider-contract.js';
const FAKE_REL = 'scripts/lib/email-grant-envelope-fake-provider.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const PKG_PATH = path.join(ROOT, 'package.json');
const PROD_PATH = path.join(ROOT, PROD_REL);
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const DOC_PATH = path.join(ROOT, DOC_REL);

const envc = require('./lib/email-grant-envelope-provider-contract');
const {
  createAzureKvEmailGrantEnvelopeProvider,
  createAzureKvEmailDeltaCursorEnvelopeProvider,
  buildVersionedKeyId,
  parseVersionedKeyId,
  PROD_WRAP_ALG,
} = require('./lib/email-grant-envelope-azure-kv-provider');
const {
  buildDeltaCursorEnvelopeAadV1,
} = require('./lib/email-inbound-delta-state-store');

const HOST = 'wh-staging-kv.vault.azure.net';
const KEK_NAME = 'luna-email-grant-kek';
const KEK_VERSION = 'a1b2c3d4e5f6789012345678abcdef01';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLANTED = 'password=LEAKED_SECRET_VALUE_DO_NOT_ECHO';
const TARGET_KEY_ID = `https://${HOST}/keys/${KEK_NAME}/${KEK_VERSION}`;

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

function serializeSafe(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function noPlanted(v) {
  const s = serializeSafe(v);
  return !s.includes(PLANTED) && !s.includes('LEAKED_SECRET')
    && !s.includes('BEGIN RSA') && !s.includes('private_key');
}

/** Local RSA-OAEP-256 CryptographyClient fake (real Node crypto). */
function createRsaCryptoFake(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const modulusLength = options.modulusLength === 4096 ? 4096 : 3072;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength });
  const calls = [];
  let failMode = null; // { op, error } or function
  let responseMode = null; // mutate response
  let clientFactory = null;

  const wrapOpts = {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  };
  const unwrapOpts = {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  };

  function makeClient(keyId) {
    if (typeof clientFactory === 'function') return clientFactory(keyId);
    async function wrapKey(algorithm, key) {
      calls.push({ op: 'wrapKey', algorithm, keyId, keyLen: key && key.length });
      if (failMode && (failMode.op === 'wrapKey' || failMode.op === 'any')) {
        throw failMode.error;
      }
      if (algorithm !== 'RSA-OAEP-256') {
        throw Object.assign(new Error('bad alg'), { statusCode: 400 });
      }
      const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
      const result = crypto.publicEncrypt(wrapOpts, buf);
      let resp = { result, algorithm, keyID: keyId };
      if (typeof responseMode === 'function') resp = responseMode('wrapKey', resp, keyId);
      return resp;
    }
    async function unwrapKey(algorithm, encryptedKey) {
      calls.push({ op: 'unwrapKey', algorithm, keyId, wrapLen: encryptedKey && encryptedKey.length });
      if (failMode && (failMode.op === 'unwrapKey' || failMode.op === 'any')) {
        throw failMode.error;
      }
      if (algorithm !== 'RSA-OAEP-256') {
        throw Object.assign(new Error('bad alg'), { statusCode: 400 });
      }
      const buf = Buffer.isBuffer(encryptedKey) ? encryptedKey : Buffer.from(encryptedKey);
      const result = crypto.privateDecrypt(unwrapOpts, buf);
      let resp = { result, algorithm, keyID: keyId };
      if (typeof responseMode === 'function') resp = responseMode('unwrapKey', resp, keyId);
      return resp;
    }
    return { wrapKey, unwrapKey };
  }

  return {
    calls,
    publicKey,
    privateKey,
    modulusLength,
    setFail(mode) { failMode = mode; },
    setResponseMode(fn) { responseMode = fn; },
    setClientFactory(fn) { clientFactory = fn; },
    getCryptographyClient(fullVersionedKeyId) {
      calls.push({ op: 'getCryptographyClient', keyId: fullVersionedKeyId });
      return makeClient(fullVersionedKeyId);
    },
    /** Independent GCM decrypt using private key + envelope. */
    independentOpen(envelope, aad) {
      const dek = crypto.privateDecrypt(unwrapOpts, envelope.wrapped_dek);
      if (dek.length !== 32) throw new Error('dek_len');
      const decipher = crypto.createDecipheriv('aes-256-gcm', dek, envelope.nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(envelope.auth_tag);
      const pt = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      return envc.decodeDelegatedRefreshPackageV1(pt);
    },
  };
}

function baseConfig(fake, extra) {
  return {
    trustedVaultHosts: [HOST],
    kekKeyName: KEK_NAME,
    kekKeyVersion: KEK_VERSION,
    getCryptographyClient: (id) => fake.getCryptographyClient(id),
    ...(extra || {}),
  };
}

function aadFor(gen, op) {
  return envc.buildGrantEnvelopeAadV1({
    clientId: CLIENT, endpointId: ENDPOINT, grantGeneration: gen, operationId: op,
  });
}

async function main() {
  console.log('verify:email-grant-envelope-azure-kv-provider (Slice 2F-B)');

  // --- static / package / docs ---
  {
    const src = fs.readFileSync(PROD_PATH, 'utf8');
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    ok('package script present',
      pkg.scripts && pkg.scripts['verify:email-grant-envelope-azure-kv-provider']);
    ok('docs mention Standard KV RSA-OAEP-256',
      /RSA-OAEP-256/i.test(doc) && /Standard/i.test(doc) && /2F-B/i.test(doc));
    ok('docs reject A256KW production path',
      /A256KW/i.test(doc) && (/Premium|Managed HSM|not used/i.test(doc)));
    ok('docs full reseal rewrap', /reseal|full decrypt/i.test(doc));
    ok('docs exact version pin', /version-?pin|exact version|never.*latest/i.test(doc));
    ok('static no @azure/identity', !/@azure\/identity/.test(src));
    ok('static no SecretClient/setSecret',
      !/SecretClient|setSecret/.test(src));
    ok('static no DefaultAzureCredential', !/DefaultAzureCredential/.test(src));
    ok('static no KeyClient/getKey', !/\bKeyClient\b|\.getKey\b/.test(src));
    ok('static no Graph/routes/activation',
      !/graph\.microsoft|staff-query-api|activation_enabled\s*=\s*true/i.test(src));
    ok('static no require @azure', !/require\s*\(\s*['"]@azure\//.test(src));
    ok('static documents RSA-OAEP-256 only', /RSA-OAEP-256/.test(src) && /A256KW/.test(src));
    ok('static zero provider-level retry preference',
      /zero.*retr|Prefer zero|no provider-level retr/i.test(src));
    ok('PROD_WRAP_ALG is RSA-OAEP-256', PROD_WRAP_ALG === 'RSA-OAEP-256');
    ok('2F-A fake still A256KW (unchanged contract proof)',
      /FAKE_WRAP_ALG\s*=\s*['"]A256KW['"]/.test(fs.readFileSync(path.join(ROOT, FAKE_REL), 'utf8')));
    ok('migration still allows RSA-OAEP-256',
      /RSA-OAEP-256/.test(fs.readFileSync(
        path.join(ROOT, 'database/migrations/059_tenant_email_delegated_grants.sql'), 'utf8',
      )));
  }

  // --- key id parse/build ---
  {
    const id = buildVersionedKeyId(HOST, KEK_NAME, KEK_VERSION);
    ok('build versioned key id', id === TARGET_KEY_ID);
    const hosts = new Set([HOST]);
    const p = parseVersionedKeyId(TARGET_KEY_ID, hosts);
    ok('parse versioned key id', p && p.keyId === TARGET_KEY_ID && p.name === KEK_NAME);
    ok('reject query', parseVersionedKeyId(`${TARGET_KEY_ID}?api-version=7.4`, hosts) === null);
    ok('reject fragment', parseVersionedKeyId(`${TARGET_KEY_ID}#x`, hosts) === null);
    ok('reject path traversal', parseVersionedKeyId(
      `https://${HOST}/keys/../secrets/x/${KEK_VERSION}`, hosts,
    ) === null);
    ok('reject unversioned', parseVersionedKeyId(
      `https://${HOST}/keys/${KEK_NAME}`, hosts,
    ) === null);
    ok('reject latest version token in build',
      buildVersionedKeyId(HOST, KEK_NAME, 'latest') === null);
    ok('reject untrusted host', parseVersionedKeyId(
      `https://evil.vault.azure.net/keys/${KEK_NAME}/${KEK_VERSION}`, hosts,
    ) === null);
    ok('reject http', parseVersionedKeyId(
      `http://${HOST}/keys/${KEK_NAME}/${KEK_VERSION}`, hosts,
    ) === null);
  }

  // --- config validation ---
  {
    let threw = false;
    try {
      createAzureKvEmailGrantEnvelopeProvider(null);
    } catch (e) {
      threw = e.code === 'envelope_provider_config_invalid';
    }
    ok('null config rejected', threw);

    threw = false;
    try {
      createAzureKvEmailGrantEnvelopeProvider({
        trustedVaultHosts: [HOST], kekKeyName: KEK_NAME, kekKeyVersion: 'latest',
        getCryptographyClient: () => ({}),
      });
    } catch (e) {
      threw = e.code === 'envelope_provider_config_invalid';
    }
    ok('latest version config rejected', threw);

    threw = false;
    try {
      createAzureKvEmailGrantEnvelopeProvider({
        trustedVaultHosts: [HOST], kekKeyName: KEK_NAME, kekKeyVersion: KEK_VERSION,
        wrapAlg: 'A256KW',
        getCryptographyClient: () => ({}),
      });
    } catch (e) {
      threw = e.code === 'envelope_a256kw_rejected';
    }
    ok('A256KW config rejected', threw);

    threw = false;
    try {
      createAzureKvEmailGrantEnvelopeProvider({
        trustedVaultHosts: [HOST], kekKeyName: KEK_NAME, kekKeyVersion: KEK_VERSION,
        getCryptographyClient: () => ({}),
        [Symbol('x')]: 1,
      });
    } catch (e) {
      threw = e && e.code === 'envelope_provider_config_invalid';
    }
    ok('symbol key config rejected', threw);

    threw = false;
    try {
      const hostile = {};
      Object.defineProperty(hostile, 'kekKeyName', {
        get() { throw new Error(PLANTED); },
        enumerable: true,
      });
      hostile.trustedVaultHosts = [HOST];
      hostile.kekKeyVersion = KEK_VERSION;
      hostile.getCryptographyClient = () => ({});
      createAzureKvEmailGrantEnvelopeProvider(hostile);
    } catch (e) {
      threw = e.code === 'envelope_provider_config_invalid' && noPlanted(e);
    }
    ok('hostile getter config fail-closed no plant', threw);

    threw = false;
    try {
      createAzureKvEmailGrantEnvelopeProvider({
        trustedVaultHosts: ['Evil.Vault.Azure.Net'],
        kekKeyName: KEK_NAME, kekKeyVersion: KEK_VERSION,
        getCryptographyClient: () => ({}),
      });
    } catch (e) {
      threw = e.code === 'envelope_provider_config_invalid';
    }
    ok('uppercase host rejected', threw);
  }

  // --- provider shape + happy path round-trip ---
  {
    const fake = createRsaCryptoFake({ modulusLength: 3072 });
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    ok('provider exact 3 keys',
      Reflect.ownKeys(prov).length === 3
      && typeof prov.sealGrantPayload === 'function'
      && typeof prov.openGrantPayload === 'function'
      && typeof prov.rewrapGrantDek === 'function');
    ok('provider validates via 2F-A contract',
      envc.validateEmailGrantEnvelopeProvider(prov).ok);
    ok('provider frozen', Object.isFrozen(prov));

    const op = crypto.randomUUID();
    const aad = aadFor(1, op);
    const sealed = await prov.sealGrantPayload({
      refresh_token: 'rt-prod-round-trip', aad, operation_id: op,
    });
    ok('seal RSA-OAEP-256 metadata',
      sealed.kek_wrap_alg === 'RSA-OAEP-256'
      && sealed.kek_key_name === KEK_NAME
      && sealed.kek_key_version === KEK_VERSION
      && sealed.nonce.length === 12
      && sealed.auth_tag.length === 16
      && (sealed.wrapped_dek.length === 384 || sealed.wrapped_dek.length === 512));
    ok('seal envelope validates contract', envc.validateGrantEnvelopeRecordV1(sealed).ok);
    ok('wrap called with RSA-OAEP-256 + 32B + exact key id',
      fake.calls.some((c) => c.op === 'wrapKey' && c.algorithm === 'RSA-OAEP-256'
        && c.keyLen === 32 && c.keyId === TARGET_KEY_ID));
    ok('getCryptographyClient got full versioned id',
      fake.calls.some((c) => c.op === 'getCryptographyClient' && c.keyId === TARGET_KEY_ID));

    const opened = await prov.openGrantPayload({ envelope: sealed, aad });
    ok('open round-trip', opened.refresh_token === 'rt-prod-round-trip');
    ok('unwrap call order after wrap', (() => {
      const wi = fake.calls.findIndex((c) => c.op === 'wrapKey');
      const ui = fake.calls.findIndex((c) => c.op === 'unwrapKey');
      return wi >= 0 && ui > wi && fake.calls[ui].algorithm === 'RSA-OAEP-256'
        && fake.calls[ui].keyId === TARGET_KEY_ID;
    })());

    const indep = fake.independentOpen(sealed, aad);
    ok('independent GCM decrypt matches',
      indep.ok && indep.value.refresh_token === 'rt-prod-round-trip');
  }

  // --- dedicated delta-cursor AAD policy; grant policy remains disjoint ---
  {
    const fake = createRsaCryptoFake({ modulusLength: 3072 });
    const cfg = baseConfig(fake);
    const grantProvider = createAzureKvEmailGrantEnvelopeProvider(cfg);
    const cursorProvider = createAzureKvEmailDeltaCursorEnvelopeProvider(cfg);
    const op = crypto.randomUUID();
    const cursorAad = buildDeltaCursorEnvelopeAadV1({
      clientId: CLIENT,
      endpointId: ENDPOINT,
      provider: 'microsoft_graph',
      providerTenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      providerMailboxId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ingestionGeneration: 1,
      queryVersion: 'ms_messages_delta_from_now_v2',
      cursorKind: 'deltaLink',
    });
    const compatibilityAad = buildDeltaCursorEnvelopeAadV1({
      clientId: { toString: () => CLIENT.toUpperCase() },
      endpointId: { toString: () => ENDPOINT },
      provider: 'microsoft_graph',
      providerTenantId: { toString: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      providerMailboxId: { toString: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      ingestionGeneration: 1n,
      queryVersion: 'ms_messages_delta_from_now_v2',
      cursorKind: 'deltaLink',
    });
    ok('extracted cursor AAD preserves bigint and String-coercible UUID semantics',
      compatibilityAad.equals(cursorAad));
    const sealed = await cursorProvider.sealGrantPayload({
      refresh_token: 'opaque-delta-cursor-package',
      aad: cursorAad,
      operation_id: op,
    });
    const opened = await cursorProvider.openGrantPayload({ envelope: sealed, aad: cursorAad });
    ok('delta cursor AAD seals and opens under dedicated provider',
      opened.refresh_token === 'opaque-delta-cursor-package');
    let grantRejected = false;
    try {
      await grantProvider.sealGrantPayload({
        refresh_token: 'opaque-delta-cursor-package', aad: cursorAad, operation_id: op,
      });
    } catch (error) {
      grantRejected = error && error.code === 'envelope_seal_failed';
    }
    ok('grant provider still rejects delta cursor AAD', grantRejected);
    const grantAad = aadFor(1, op);
    let cursorRejected = false;
    try {
      await cursorProvider.sealGrantPayload({
        refresh_token: 'rt', aad: grantAad, operation_id: op,
      });
    } catch (error) {
      cursorRejected = error && error.code === 'envelope_seal_failed';
    }
    ok('delta cursor provider rejects grant AAD', cursorRejected);
    const hostileParserProvider = createAzureKvEmailDeltaCursorEnvelopeProvider(
      cfg,
      () => ({ ok: true, value: {} }),
    );
    let arbitraryRejected = false;
    try {
      await hostileParserProvider.sealGrantPayload({
        refresh_token: 'rt', aad: Buffer.from('arbitrary-aad'), operation_id: op,
      });
    } catch (error) {
      arbitraryRejected = error && error.code === 'envelope_seal_failed';
    }
    ok('caller cannot inject parser to broaden cursor AAD', arbitraryRejected);
  }

  // --- 4096-bit modulus (512B wrap) ---
  {
    const fake = createRsaCryptoFake({ modulusLength: 4096 });
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op = crypto.randomUUID();
    const aad = aadFor(1, op);
    const sealed = await prov.sealGrantPayload({
      refresh_token: 'rt-4096', aad, operation_id: op,
    });
    ok('4096 RSA wrap is 512B', sealed.wrapped_dek.length === 512);
    const opened = await prov.openGrantPayload({ envelope: sealed, aad });
    ok('4096 round-trip', opened.refresh_token === 'rt-4096');
  }

  // --- AAD / key / version mismatch ---
  {
    const fake = createRsaCryptoFake();
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op = crypto.randomUUID();
    const aad = aadFor(1, op);
    const sealed = await prov.sealGrantPayload({
      refresh_token: 'rt-aad', aad, operation_id: op,
    });
    let openFail = false;
    try {
      await prov.openGrantPayload({ envelope: sealed, aad: aadFor(2, op) });
    } catch (e) {
      openFail = e.code === 'envelope_open_failed' && noPlanted(e);
    }
    ok('wrong AAD fails closed', openFail);

    openFail = false;
    try {
      await prov.openGrantPayload({
        envelope: { ...sealed, kek_key_name: 'other-kek' }, aad,
      });
    } catch (e) {
      openFail = e.code === 'envelope_open_failed';
    }
    ok('wrong key name fails', openFail);

    openFail = false;
    try {
      await prov.openGrantPayload({
        envelope: { ...sealed, kek_key_version: 'latest' }, aad,
      });
    } catch (e) {
      openFail = e.code === 'envelope_open_failed' || e.code === 'envelope_record_invalid';
    }
    // validateGrantEnvelopeRecordV1 rejects latest before open alg checks
    ok('latest version on envelope fails', openFail);

    // A256KW envelope rejected
    let a256 = false;
    try {
      await prov.openGrantPayload({
        envelope: {
          ...sealed,
          kek_wrap_alg: 'A256KW',
          wrapped_dek: Buffer.alloc(40, 1),
        },
        aad,
      });
    } catch (e) {
      a256 = e.code === 'envelope_a256kw_rejected';
    }
    ok('A256KW envelope rejected (no silent fallback)', a256);
  }

  // --- rewrap full reseal ---
  {
    const fake = createRsaCryptoFake();
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op1 = crypto.randomUUID();
    const op2 = crypto.randomUUID();
    const aad1 = aadFor(1, op1);
    const aad2 = aadFor(2, op2);
    const sealed = await prov.sealGrantPayload({
      refresh_token: 'rt-rewrap', aad: aad1, operation_id: op1,
    });
    const rewrapped = await prov.rewrapGrantDek({
      envelope: sealed, aad: aad1, next_aad: aad2, operation_id: op2,
    });
    ok('rewrap new generation metadata',
      rewrapped.operation_id === op2
      && rewrapped.kek_wrap_alg === 'RSA-OAEP-256'
      && rewrapped.kek_key_version === KEK_VERSION);
    ok('rewrap fresh DEK (wrapped differs)',
      !rewrapped.wrapped_dek.equals(sealed.wrapped_dek));
    ok('rewrap fresh nonce', !rewrapped.nonce.equals(sealed.nonce));
    const opened = await prov.openGrantPayload({ envelope: rewrapped, aad: aad2 });
    ok('rewrap open under next_aad', opened.refresh_token === 'rt-rewrap');
    let oldFail = false;
    try {
      await prov.openGrantPayload({ envelope: rewrapped, aad: aad1 });
    } catch { oldFail = true; }
    ok('rewrap not openable under old aad', oldFail);

    let sameFail = false;
    try {
      await prov.rewrapGrantDek({
        envelope: sealed, aad: aad1, next_aad: aad1, operation_id: op2,
      });
    } catch (e) {
      sameFail = e.code === 'envelope_rewrap_failed';
    }
    ok('same next_aad rejected', sameFail);

    let missFail = false;
    try {
      await prov.rewrapGrantDek({
        envelope: sealed, aad: aad1, operation_id: op2,
      });
    } catch (e) {
      missFail = e.code === 'envelope_rewrap_failed';
    }
    ok('missing next_aad rejected', missFail);
  }

  // --- malformed SDK responses ---
  {
    const fake = createRsaCryptoFake();
    fake.setResponseMode(() => ({ not_result: true }));
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op = crypto.randomUUID();
    let bad = false;
    try {
      await prov.sealGrantPayload({
        refresh_token: 'x', aad: aadFor(1, op), operation_id: op,
      });
    } catch (e) {
      bad = e.code === 'envelope_kv_response_invalid' && noPlanted(e);
    }
    ok('malformed wrap response rejected', bad);

    const fake2 = createRsaCryptoFake();
    fake2.setResponseMode((_op, resp) => ({
      result: resp.result,
      keyID: 'https://other.vault.azure.net/keys/x/y',
    }));
    const prov2 = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake2));
    bad = false;
    try {
      await prov2.sealGrantPayload({
        refresh_token: 'x', aad: aadFor(1, op), operation_id: op,
      });
    } catch (e) {
      bad = e.code === 'envelope_kv_response_invalid';
    }
    ok('mismatched keyID in response rejected', bad);

    const fake3 = createRsaCryptoFake();
    fake3.setResponseMode((_op, resp) => {
      const o = { result: resp.result, keyID: TARGET_KEY_ID };
      Object.defineProperty(o, 'extra', {
        get() { throw new Error(PLANTED); },
        enumerable: true,
      });
      return o;
    });
    const prov3 = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake3));
    bad = false;
    try {
      await prov3.sealGrantPayload({
        refresh_token: 'x', aad: aadFor(1, op), operation_id: op,
      });
    } catch (e) {
      bad = (e.code === 'envelope_kv_response_invalid' || e.code === 'envelope_seal_failed')
        && noPlanted(e);
    }
    ok('hostile response getter fail-closed no plant', bad);

    const fake4 = createRsaCryptoFake();
    fake4.setResponseMode((_op, resp, keyId) => ({
      result: resp.result, keyID: keyId,
    }));
    // wrong unwrap length
    fake4.setResponseMode((opName, resp, keyId) => {
      if (opName === 'unwrapKey') {
        return { result: Buffer.alloc(16, 0), keyID: keyId };
      }
      return { result: resp.result, keyID: keyId };
    });
    const prov4 = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake4));
    const sealed = await (async () => {
      const f = createRsaCryptoFake();
      const p = createAzureKvEmailGrantEnvelopeProvider(baseConfig(f));
      return p.sealGrantPayload({
        refresh_token: 'rt', aad: aadFor(1, op), operation_id: op,
      });
    })();
    // Use fake4 which returns short DEK — need matching wrap though.
    // Instead open with response mode on unwrap only after proper seal from same key — can't.
    // Unit: inject unwrap that returns 16B after real wrap by sharing key material.
    bad = false;
    try {
      // seal with fake4 (wrap ok), open with short unwrap
      const s = await prov4.sealGrantPayload({
        refresh_token: 'rt-short', aad: aadFor(1, op), operation_id: op,
      });
      await prov4.openGrantPayload({ envelope: s, aad: aadFor(1, op) });
    } catch (e) {
      bad = e.code === 'envelope_kv_response_invalid' || e.code === 'envelope_open_failed';
    }
    ok('unwrap non-32B result rejected', bad);
  }

  // --- planted Azure errors / 429 / auth / timeout ---
  {
    const cases = [
      { statusCode: 429, expect: 'envelope_kv_transient', name: '429' },
      { statusCode: 503, expect: 'envelope_kv_transient', name: '503' },
      { statusCode: 408, expect: 'envelope_kv_transient', name: '408' },
      { statusCode: 401, expect: 'envelope_kv_auth_failed', name: '401' },
      { statusCode: 403, expect: 'envelope_kv_auth_failed', name: '403' },
      { statusCode: 404, expect: 'envelope_kv_not_found', name: '404' },
      { code: 'ETIMEDOUT', expect: 'envelope_kv_transient', name: 'timeout' },
    ];
    for (const c of cases) {
      const fake = createRsaCryptoFake();
      const planted = Object.assign(new Error(`Azure said ${PLANTED}`), c);
      fake.setFail({ op: 'wrapKey', error: planted });
      const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
      const op = crypto.randomUUID();
      let mapped = false;
      try {
        await prov.sealGrantPayload({
          refresh_token: 'x', aad: aadFor(1, op), operation_id: op,
        });
      } catch (e) {
        mapped = e.code === c.expect && noPlanted(e) && !String(e.message).includes('LEAK');
      }
      ok(`SDK error ${c.name} → ${c.expect} sanitized`, mapped);
    }
    // zero retry: wrapKey called once only on failure
    const fake = createRsaCryptoFake();
    fake.setFail({
      op: 'wrapKey',
      error: Object.assign(new Error('rate'), { statusCode: 429 }),
    });
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op = crypto.randomUUID();
    try {
      await prov.sealGrantPayload({
        refresh_token: 'x', aad: aadFor(1, op), operation_id: op,
      });
    } catch { /* expected */ }
    const wrapCalls = fake.calls.filter((x) => x.op === 'wrapKey');
    ok('zero provider-level retry on 429', wrapCalls.length === 1);
  }

  // --- hostile client surface ---
  {
    const fake = createRsaCryptoFake();
    fake.setClientFactory(() => ({
      get wrapKey() { throw new Error(PLANTED); },
      unwrapKey: async () => ({}),
    }));
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op = crypto.randomUUID();
    let bad = false;
    try {
      await prov.sealGrantPayload({
        refresh_token: 'x', aad: aadFor(1, op), operation_id: op,
      });
    } catch (e) {
      bad = e.code === 'envelope_kv_client_invalid' && noPlanted(e);
    }
    ok('client accessor wrapKey rejected no plant', bad);

    fake.setClientFactory(() => ({ wrapKey: async () => ({}), /* no unwrapKey */ }));
    // seal only needs wrapKey — still require both for client validity
    bad = false;
    try {
      await prov.sealGrantPayload({
        refresh_token: 'x', aad: aadFor(1, op), operation_id: op,
      });
    } catch (e) {
      bad = e.code === 'envelope_kv_client_invalid';
    }
    ok('client missing unwrapKey rejected', bad);
  }

  // --- hostile seal input ---
  {
    const fake = createRsaCryptoFake();
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op = crypto.randomUUID();
    let bad = false;
    try {
      const input = {};
      Object.defineProperty(input, 'refresh_token', {
        get() { throw new Error(PLANTED); },
        enumerable: true,
      });
      input.aad = aadFor(1, op);
      input.operation_id = op;
      await prov.sealGrantPayload(input);
    } catch (e) {
      bad = e.code === 'envelope_seal_failed' && noPlanted(e);
    }
    ok('hostile seal input fail-closed', bad);

    bad = false;
    try {
      await prov.sealGrantPayload({
        refresh_token: 'x',
        aad: aadFor(1, op),
        operation_id: 'not-a-uuid',
      });
    } catch (e) {
      bad = e.code === 'envelope_seal_failed';
    }
    ok('non-uuid operation_id rejected', bad);
  }

  // --- network isolation ---
  {
    const origLookup = dns.lookup;
    const origHttps = https.request;
    const origHttp = http.request;
    const origConnect = net.connect;
    let netHit = false;
    dns.lookup = (..._a) => { netHit = true; throw new Error('dns_blocked'); };
    https.request = (..._a) => { netHit = true; throw new Error('https_blocked'); };
    http.request = (..._a) => { netHit = true; throw new Error('http_blocked'); };
    net.connect = (..._a) => { netHit = true; throw new Error('net_blocked'); };
    try {
      const fake = createRsaCryptoFake();
      const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
      const op = crypto.randomUUID();
      const aad = aadFor(1, op);
      const sealed = await prov.sealGrantPayload({
        refresh_token: 'rt-offline', aad, operation_id: op,
      });
      await prov.openGrantPayload({ envelope: sealed, aad });
      ok('no network during seal/open', !netHit);
    } finally {
      dns.lookup = origLookup;
      https.request = origHttps;
      http.request = origHttp;
      net.connect = origConnect;
    }
  }

  // --- zeroization observable on owned plaintext buffer path ---
  {
    const fake = createRsaCryptoFake();
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op = crypto.randomUUID();
    // plaintext path: provider zeroizes only owned encoded package; refresh_token string not zeroized
    // Observe dek zeroization via wrapKey receiving a buffer we can check after seal completes:
    // the provider copies? It passes dek to wrapKey — SDK fake may hold reference.
    let seenDek = null;
    fake.setClientFactory((keyId) => ({
      async wrapKey(algorithm, key) {
        seenDek = key;
        const result = crypto.publicEncrypt({
          key: fake.publicKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        }, Buffer.from(key));
        return { result, algorithm, keyID: keyId };
      },
      async unwrapKey() { throw new Error('unused'); },
    }));
    await prov.sealGrantPayload({
      refresh_token: 'rt-zero', aad: aadFor(1, op), operation_id: op,
    });
    ok('DEK buffer zeroized after seal (best-effort)',
      Buffer.isBuffer(seenDek) && seenDek.length === 32 && seenDek.equals(Buffer.alloc(32)));
  }

  // --- multi-host requires vaultHost ---
  {
    let threw = false;
    try {
      createAzureKvEmailGrantEnvelopeProvider({
        trustedVaultHosts: [HOST, 'other-kv.vault.azure.net'],
        kekKeyName: KEK_NAME,
        kekKeyVersion: KEK_VERSION,
        getCryptographyClient: () => ({ wrapKey: async () => {}, unwrapKey: async () => {} }),
      });
    } catch (e) {
      threw = e.code === 'envelope_provider_config_invalid';
    }
    ok('multi-host without vaultHost rejected', threw);

    const fake = createRsaCryptoFake();
    const prov = createAzureKvEmailGrantEnvelopeProvider({
      trustedVaultHosts: [HOST, 'other-kv.vault.azure.net'],
      vaultHost: HOST,
      kekKeyName: KEK_NAME,
      kekKeyVersion: KEK_VERSION,
      getCryptographyClient: (id) => fake.getCryptographyClient(id),
    });
    const op = crypto.randomUUID();
    const sealed = await prov.sealGrantPayload({
      refresh_token: 'rt-mh', aad: aadFor(1, op), operation_id: op,
    });
    ok('multi-host with vaultHost seals', sealed.kek_key_name === KEK_NAME);
  }

  // --- hostile trustedVaultHosts + AAD↔operation_id binding ---
  {
    const deadClient = () => ({ wrapKey: async () => {}, unwrapKey: async () => {} });
    const cfgH = (hosts) => ({
      trustedVaultHosts: hosts, kekKeyName: KEK_NAME, kekKeyVersion: KEK_VERSION,
      getCryptographyClient: deadClient,
    });
    const confBad = (hosts) => {
      try { createAzureKvEmailGrantEnvelopeProvider(cfgH(hosts)); return false; }
      catch (e) { return e.code === 'envelope_provider_config_invalid' && noPlanted(e); }
    };
    let iterOk = false;
    try {
      createAzureKvEmailGrantEnvelopeProvider(cfgH(new Proxy([HOST], {
        get(t, p, r) {
          if (p === Symbol.iterator) throw new Error(PLANTED);
          return Reflect.get(t, p, r);
        },
      })));
      iterOk = true;
    } catch (e) { iterOk = e.code === 'envelope_provider_config_invalid' && noPlanted(e); }
    ok('hosts proxy Symbol.iterator never leaks', iterOk);
    ok('hosts proxy getOwnPropertyDescriptor throw sanitized',
      confBad(new Proxy([HOST], { getOwnPropertyDescriptor() { throw new Error(PLANTED); } })));
    ok('hosts proxy ownKeys throw sanitized',
      confBad(new Proxy([HOST], { ownKeys() { throw new Error(PLANTED); } })));
    ok('hosts proxy getPrototypeOf throw sanitized',
      confBad(new Proxy([HOST], { getPrototypeOf() { throw new Error(PLANTED); } })));
    let getterHit = false;
    const acc = ['x'];
    Object.defineProperty(acc, '0', {
      get() { getterHit = true; throw new Error(PLANTED); },
      set() {}, enumerable: true, configurable: true,
    });
    ok('hosts index accessor rejected no invoke', confBad(acc) && !getterHit);

    const fake = createRsaCryptoFake();
    const prov = createAzureKvEmailGrantEnvelopeProvider(baseConfig(fake));
    const op1 = crypto.randomUUID();
    const op2 = crypto.randomUUID();
    const opX = crypto.randomUUID();
    const aad1 = aadFor(1, op1);
    const sealed = await prov.sealGrantPayload({
      refresh_token: 'rt-bind', aad: aad1, operation_id: op1,
    });
    async function expectCode(fn, code) {
      try { await fn(); return false; }
      catch (e) { return e.code === code && noPlanted(e); }
    }
    ok('seal rejects AAD op != operation_id', await expectCode(
      () => prov.sealGrantPayload({ refresh_token: 'x', aad: aadFor(1, op1), operation_id: op2 }),
      'envelope_seal_failed',
    ));
    ok('open rejects AAD op != envelope.operation_id', await expectCode(
      () => prov.openGrantPayload({ envelope: sealed, aad: aadFor(1, op2) }),
      'envelope_open_failed',
    ));
    ok('rewrap rejects next_aad unrelated op', await expectCode(
      () => prov.rewrapGrantDek({
        envelope: sealed, aad: aad1, next_aad: aadFor(2, opX), operation_id: op2,
      }),
      'envelope_rewrap_failed',
    ));
    ok('rewrap rejects old aad/envelope op mismatch', await expectCode(
      () => prov.rewrapGrantDek({
        envelope: { ...sealed, operation_id: op2 },
        aad: aad1, next_aad: aadFor(2, op2), operation_id: op2,
      }),
      'envelope_rewrap_failed',
    ));
    const OC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const OE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    ok('rewrap rejects next cross-client', await expectCode(
      () => prov.rewrapGrantDek({
        envelope: sealed, aad: aad1, operation_id: op2,
        next_aad: envc.buildGrantEnvelopeAadV1({
          clientId: OC, endpointId: ENDPOINT, grantGeneration: 2, operationId: op2,
        }),
      }),
      'envelope_rewrap_failed',
    ));
    ok('rewrap rejects next cross-endpoint', await expectCode(
      () => prov.rewrapGrantDek({
        envelope: sealed, aad: aad1, operation_id: op2,
        next_aad: envc.buildGrantEnvelopeAadV1({
          clientId: CLIENT, endpointId: OE, grantGeneration: 2, operationId: op2,
        }),
      }),
      'envelope_rewrap_failed',
    ));
    for (const [label, gen] of [['same', 1], ['skipped', 3], ['decreasing', 0]]) {
      const next = gen < 1
        ? Buffer.from(`v1\naad_v1\nclient_id=${CLIENT}\nendpoint_id=${ENDPOINT}\ngrant_generation=0\noperation_id=${op2}`)
        : aadFor(gen, op2);
      ok(`rewrap rejects ${label} generation`, await expectCode(
        () => prov.rewrapGrantDek({
          envelope: sealed, aad: aad1, next_aad: next, operation_id: op2,
        }),
        'envelope_rewrap_failed',
      ));
    }
    const mal = [
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from(`v1\naad_v1\nendpoint_id=${ENDPOINT}\nclient_id=${CLIENT}\ngrant_generation=1\noperation_id=${op1}`),
      Buffer.from(`v2\naad_v1\nclient_id=${CLIENT}\nendpoint_id=${ENDPOINT}\ngrant_generation=1\noperation_id=${op1}`),
      Buffer.from(`v1\naad_v1\nclient_id=${CLIENT}\nendpoint_id=${ENDPOINT}\ngrant_generation=01\noperation_id=${op1}`),
    ];
    let malOk = true;
    for (const m of mal) {
      if (envc.parseGrantEnvelopeAadV1(m).ok) malOk = false;
      if (!(await expectCode(
        () => prov.sealGrantPayload({ refresh_token: 'x', aad: m, operation_id: op1 }),
        'envelope_seal_failed',
      ))) malOk = false;
    }
    ok('malformed AAD utf8/keys/order/leading-zero rejected', malOk);
    const nextOk = await prov.rewrapGrantDek({
      envelope: sealed, aad: aad1, next_aad: aadFor(2, op2), operation_id: op2,
    });
    const openedNext = await prov.openGrantPayload({ envelope: nextOk, aad: aadFor(2, op2) });
    ok('valid exact next-gen rewrap still works',
      nextOk.operation_id === op2 && openedNext.refresh_token === 'rt-bind');
    const good = envc.parseGrantEnvelopeAadV1(aad1);
    ok('parseGrantEnvelopeAadV1 happy path',
      good.ok && good.value.operation_id === op1 && good.value.grant_generation === 1n);
  }

  // --- contract still allows both algs in schema (2F-A unchanged) ---
  {
    ok('2F-A KEK algs still include A256KW for fake',
      envc.KEK_WRAP_ALGS_V1.includes('A256KW')
      && envc.KEK_WRAP_ALGS_V1.includes('RSA-OAEP-256'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('verifier crashed', e && e.message);
  process.exit(2);
});
