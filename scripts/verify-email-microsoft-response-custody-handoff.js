'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  FAILURE_CODE,
  JSON_LIMIT_BYTES,
  TOKEN_LIMIT_CHARS,
  ID_TOKEN_LIMIT_CHARS,
  createMicrosoftTokenResponseCustodyService,
} = require('./lib/email-microsoft-response-custody-handoff');
const { RESPONSE_LIMIT_BYTES } = require('./lib/email-microsoft-token-http-transport');

const SECRET = 'ACCESS_SECRET_NEVER_LEAK';
const REFRESH = 'REFRESH_SECRET_NEVER_LEAK';
const ID_TOKEN = 'ID_TOKEN_SECRET_NEVER_LEAK.header.payload.sig';
const SELECTED_KEYS = Object.freeze(['accessToken', 'refreshToken', 'tokenType', 'expiresIn', 'scope', 'idToken']);
const GOOD = {
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send',
  access_token: SECRET,
  refresh_token: REFRESH,
  id_token: ID_TOKEN,
};
const EXPECTED_SELECTED = Object.freeze({
  accessToken: SECRET,
  refreshToken: REFRESH,
  tokenType: 'Bearer',
  expiresIn: 3600,
  scope: GOOD.scope,
  idToken: ID_TOKEN,
});

function harness(spec, accept) {
  const incoming = new EventEmitter(); incoming.statusCode = spec.statusCode ?? 200;
  incoming.headers = { 'content-type': spec.contentType ?? 'application/json; charset=utf-8' };
  incoming.destroy = () => {};
  const request = new EventEmitter(); request.end = () => {
    queueMicrotask(() => { callback(incoming); incoming.emit('data', spec.body ?? JSON.stringify(GOOD)); incoming.emit('end'); });
  }; request.destroy = () => {};
  let callback;
  const httpsImpl = { request(_options, cb) { callback = cb; return request; } };
  const timers = { setTimeout() { return 1; }, clearTimeout() {} };
  return createMicrosoftTokenResponseCustodyService({ transportDeps: { httpsImpl, timers }, custody: { acceptValidatedTokens: accept } });
}

/** Build a valid token JSON body with exact UTF-8 byte length using ignored client_info pad. */
function bodyWithExactBytes(base, targetBytes) {
  const seed = { ...base, client_info: '' };
  const empty = JSON.stringify(seed);
  const emptyBytes = Buffer.byteLength(empty, 'utf8');
  assert.ok(emptyBytes <= targetBytes, 'base body already exceeds target');
  const padLen = targetBytes - emptyBytes;
  const body = JSON.stringify({ ...base, client_info: 'p'.repeat(padLen) });
  assert.equal(Buffer.byteLength(body, 'utf8'), targetBytes);
  return body;
}

async function succeeds(spec, accept) {
  let selected;
  const result = await harness(spec, async (value) => {
    selected = value;
    if (typeof accept === 'function') return accept(value);
    return Object.freeze({ status: 'accepted' });
  }).exchangeAndCustody({ body: 'trusted=already-encoded' });
  assert.deepEqual(result, { status: 'custodied' });
  return selected;
}

function noSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes(SECRET) && !text.includes(REFRESH) && !text.includes(ID_TOKEN);
}

async function fails(spec, accept = async () => Object.freeze({ status: 'accepted' })) {
  try { await harness(spec, accept).exchangeAndCustody({ body: 'trusted=already-encoded' }); assert.fail('expected failure'); }
  catch (error) {
    assert.equal(error.code, FAILURE_CODE); assert.equal(error.message, FAILURE_CODE);
    assert.equal(noSecrets(error), true);
    assert.equal(noSecrets(String(error)), true);
    assert.equal(Object.hasOwn(error, 'idToken'), false);
    assert.equal(Object.hasOwn(error, 'id_token'), false);
  }
}

async function main() {
  const logged = []; const original = console.log; const originalError = console.error;
  console.log = console.error = (...args) => logged.push(args);
  try {
    // Anti-drift: custody JSON bound equals exported transport response cap.
    assert.equal(JSON_LIMIT_BYTES, RESPONSE_LIMIT_BYTES);
    assert.equal(JSON_LIMIT_BYTES, 65_536);
    // Access/refresh remain 8KiB; id_token is the separate OIDC-aligned 32KiB bound.
    assert.equal(TOKEN_LIMIT_CHARS, 8192);
    assert.equal(ID_TOKEN_LIMIT_CHARS, 32768);
    // OIDC LIMITS is not exported; keep numeric alignment with LIMITS.token (merged module).
    // If LIMITS is later exported, require equality here to prevent drift.
    try {
      // eslint-disable-next-line global-require
      const oidc = require('./lib/email-microsoft-oidc-id-token');
      if (oidc && oidc.LIMITS && typeof oidc.LIMITS.token === 'number') {
        assert.equal(ID_TOKEN_LIMIT_CHARS, oidc.LIMITS.token);
      }
    } catch (_) { /* module load failure is out of scope for this anti-drift probe */ }

    await fails({ statusCode: 400, body: JSON.stringify({ error_description: `provider ${SECRET}` }) });
    await fails({ contentType: 'text/html', body: SECRET });
    await fails({ body: '{bad json ' + SECRET });
    for (const patch of [
      null, [], { token_type: 'bearer' }, { expires_in: 0 }, { expires_in: 1.5 },
      { access_token: '' }, { access_token: 'bad\ntoken' }, { refresh_token: '' },
      { scope: 'openid' }, { scope: 'openid Mail.Send' }, { scope: 'openid  profile' },
    ]) {
      const value = patch === null ? null : Array.isArray(patch) ? patch : { ...GOOD, ...patch };
      await fails({ body: JSON.stringify(value) });
    }

    // ── Microsoft v2 token-response scope semantics ─────────────────────────
    // Live telemetry root cause: callback_consumed → token_request_started →
    // token_response_received → callback_failed with no token_response_validated.
    // Microsoft v2 `scope` is effective granted *access-token* scopes; offline_access
    // is evidenced by required refresh_token and need not be echoed. Optional OIDC
    // email may appear. Require exact resource scopes User.Read + Mail.ReadWrite + Mail.Send;
    // allow only OIDC metadata openid|profile|offline_access|email; never synthesize
    // missing scopes into actual normalized custody scope.
    {
      // Realistic MS response: omits offline_access (refresh_token still required).
      const msNoOffline = await succeeds({
        body: JSON.stringify({
          ...GOOD,
          scope: 'openid profile User.Read Mail.ReadWrite Mail.Send',
        }),
      });
      assert.equal(msNoOffline.scope, 'openid profile User.Read Mail.ReadWrite Mail.Send');
      assert.equal(msNoOffline.scope.includes('offline_access'), false);
      assert.equal(msNoOffline.refreshToken, REFRESH);
      assert.equal(msNoOffline.idToken, ID_TOKEN);

      // Realistic MS response: optional OIDC email present, offline_access omitted.
      const msEmail = await succeeds({
        body: JSON.stringify({
          ...GOOD,
          scope: 'openid profile email User.Read Mail.ReadWrite Mail.Send',
        }),
      });
      assert.equal(msEmail.scope, 'openid profile email User.Read Mail.ReadWrite Mail.Send');
      assert.equal(msEmail.scope.includes('offline_access'), false);

      // offline_access may still be echoed when present (do not strip; do not require).
      const msWithOffline = await succeeds({
        body: JSON.stringify({
          ...GOOD,
          scope: 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send',
        }),
      });
      assert.equal(msWithOffline.scope, 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send');

      // Full OIDC metadata set including email + offline_access.
      const msFullOidc = await succeeds({
        body: JSON.stringify({
          ...GOOD,
          scope: 'openid profile offline_access email User.Read Mail.ReadWrite Mail.Send',
        }),
      });
      assert.equal(
        msFullOidc.scope,
        'openid profile offline_access email User.Read Mail.ReadWrite Mail.Send',
      );

      // Resource-only granted access-token scopes (no OIDC metadata echoed).
      const resourceOnly = await succeeds({
        body: JSON.stringify({ ...GOOD, scope: 'User.Read Mail.ReadWrite Mail.Send' }),
      });
      assert.equal(resourceOnly.scope, 'User.Read Mail.ReadWrite Mail.Send');
      assert.equal(resourceOnly.scope.includes('offline_access'), false);

      // Any order accepted; custody persists deterministic normalized actual scope.
      const reordered = await succeeds({
        body: JSON.stringify({
          ...GOOD,
          scope: 'Mail.Send Mail.ReadWrite email User.Read profile openid',
        }),
      });
      assert.equal(reordered.scope, 'openid profile email User.Read Mail.ReadWrite Mail.Send');
      assert.equal(reordered.scope.includes('offline_access'), false);

      // offline_access in non-canonical position still normalizes without synthesis.
      const offlineReordered = await succeeds({
        body: JSON.stringify({
          ...GOOD,
          scope: 'Mail.Send Mail.ReadWrite offline_access User.Read openid profile',
        }),
      });
      assert.equal(
        offlineReordered.scope,
        'openid profile offline_access User.Read Mail.ReadWrite Mail.Send',
      );
    }

    // Hostile token-response scope matrix (fail closed; no secrets in errors).
    for (const scope of [
      // omitted required resource scope
      'openid profile User.Read',
      'openid profile Mail.ReadWrite',
      'openid profile Mail.Send',
      'openid profile offline_access',
      'User.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'User.Read Mail.ReadWrite',
      'User.Read Mail.Send',
      // legacy / broader Graph scopes
      'openid profile User.Read Mail.ReadBasic',
      'openid profile User.Read Mail.Read',
      'openid profile User.Read Mail.ReadWrite Mail.Read',
      'User.Read.All Mail.ReadWrite Mail.Send',
      'User.Read Mail.ReadWrite Mail.Send Files.Read',
      // unknown / non-allowlisted
      'openid profile User.Read Mail.ReadWrite Mail.Send evil',
      'openid profile User.Read Mail.ReadWrite Mail.Send https://graph.microsoft.com/Mail.Read',
      'openid profile User.Read Mail.ReadWrite Mail.Send .default',
      // duplicates
      'openid openid profile User.Read Mail.ReadWrite Mail.Send',
      'User.Read User.Read Mail.ReadWrite Mail.Send',
      'openid profile User.Read Mail.ReadWrite Mail.Send Mail.Send',
      'offline_access offline_access User.Read Mail.ReadWrite Mail.Send',
      // empty tokens / double spaces / trailing separators
      'openid  profile User.Read Mail.ReadWrite Mail.Send',
      'User.Read Mail.ReadWrite Mail.Send ',
      ' User.Read Mail.ReadWrite Mail.Send',
      'User.Read  Mail.ReadWrite Mail.Send',
      '',
      ' ',
    ]) {
      await fails({ body: JSON.stringify({ ...GOOD, scope }) });
    }

    // Access/refresh exact 8192 accepted; 8193 rejected (TOKEN_LIMIT_CHARS only).
    {
      const accessOk = 'A'.repeat(TOKEN_LIMIT_CHARS);
      const refreshOk = 'R'.repeat(TOKEN_LIMIT_CHARS);
      const selected = await succeeds({
        body: JSON.stringify({ ...GOOD, access_token: accessOk, refresh_token: refreshOk }),
      });
      assert.equal(selected.accessToken, accessOk);
      assert.equal(selected.refreshToken, refreshOk);
      await fails({ body: JSON.stringify({ ...GOOD, access_token: 'A'.repeat(TOKEN_LIMIT_CHARS + 1) }) });
      await fails({ body: JSON.stringify({ ...GOOD, refresh_token: 'R'.repeat(TOKEN_LIMIT_CHARS + 1) }) });
    }

    // Required own printable bounded id_token — missing / null / empty / control /
    // non-ASCII / oversized must fail closed before custody.
    const missingId = { ...GOOD };
    delete missingId.id_token;
    await fails({ body: JSON.stringify(missingId) });
    for (const id_token of [
      null,
      '',
      'bad\ntoken',
      'bad\rtoken',
      'bad\ttoken',
      'has space',
      'tokén',
      'token\u00a0nb',
      'token\u0085',
      'x'.repeat(ID_TOKEN_LIMIT_CHARS + 1),
      1,
      true,
      { nested: ID_TOKEN },
      ['segment'],
    ]) {
      await fails({ body: JSON.stringify({ ...GOOD, id_token }) });
    }

    // Exact id_token boundary: 32768 accepted when complete response remains <=65536;
    // 32769 rejected even when total JSON is still under the response cap.
    {
      const idAtCap = 'I'.repeat(ID_TOKEN_LIMIT_CHARS);
      const bodyAtIdCap = JSON.stringify({ ...GOOD, id_token: idAtCap });
      assert.ok(Buffer.byteLength(bodyAtIdCap, 'utf8') <= JSON_LIMIT_BYTES);
      const selected = await succeeds({ body: bodyAtIdCap });
      assert.equal(selected.idToken, idAtCap);
      assert.equal(selected.idToken.length, ID_TOKEN_LIMIT_CHARS);

      const idOver = 'I'.repeat(ID_TOKEN_LIMIT_CHARS + 1);
      const bodyOverId = JSON.stringify({ ...GOOD, id_token: idOver });
      assert.ok(
        Buffer.byteLength(bodyOverId, 'utf8') <= JSON_LIMIT_BYTES,
        'id_token oversize must fail on ID_TOKEN_LIMIT_CHARS, not only JSON/response cap',
      );
      await fails({ body: bodyOverId });
    }

    // Full JSON/response boundary: exactly 65536 accepted if valid; 65537 rejected
    // (custody + transport-adjacent shared cap contract).
    {
      const exactCapBody = bodyWithExactBytes(GOOD, JSON_LIMIT_BYTES);
      assert.equal(Buffer.byteLength(exactCapBody, 'utf8'), JSON_LIMIT_BYTES);
      const selected = await succeeds({ body: exactCapBody });
      assert.deepEqual(Reflect.ownKeys(selected), [...SELECTED_KEYS]);
      assert.equal(selected.idToken, ID_TOKEN);
      assert.equal(Object.hasOwn(selected, 'client_info'), false);

      const overCapBody = bodyWithExactBytes(GOOD, JSON_LIMIT_BYTES) + ' ';
      assert.equal(Buffer.byteLength(overCapBody, 'utf8'), JSON_LIMIT_BYTES + 1);
      await fails({ body: overCapBody });
    }

    // Prototype-only id_token must not satisfy the own-data requirement.
    const priorProto = Object.prototype.id_token;
    try {
      Object.prototype.id_token = ID_TOKEN;
      await fails({ body: JSON.stringify(missingId) });
    } finally {
      if (priorProto === undefined) delete Object.prototype.id_token;
      else Object.prototype.id_token = priorProto;
    }

    // Duplicate top-level id_token rejected before custody.
    const duplicateIdValid = JSON.stringify(GOOD).replace(
      `"id_token":"${ID_TOKEN}"`,
      `"id_token":"first.id.token","id_token":"${ID_TOKEN}"`,
    );
    const duplicateIdInvalid = JSON.stringify(GOOD).replace(
      `"id_token":"${ID_TOKEN}"`,
      `"id_token":"${ID_TOKEN}","id_token":"second.id.token"`,
    );
    await fails({ body: duplicateIdValid });
    await fails({ body: duplicateIdInvalid });

    const duplicateTailValid = JSON.stringify(GOOD).replace('"token_type":"Bearer"', '"token_type":"Basic","token_type":"Bearer"');
    const duplicateTailInvalid = JSON.stringify(GOOD).replace('"token_type":"Bearer"', '"token_type":"Bearer","token_type":"Basic"');
    await fails({ body: duplicateTailValid });
    await fails({ body: duplicateTailInvalid });

    let unknownSelected;
    const unknownResult = await harness({ body: JSON.stringify({ ...GOOD, client_info: 'opaque', future_extension: { nested: ['ignored'] } }) }, async (value) => {
      unknownSelected = value;
      return Object.freeze({ status: 'accepted' });
    }).exchangeAndCustody({ body: 'trusted=already-encoded' });
    assert.deepEqual(unknownResult, { status: 'custodied' });
    assert.equal(Object.hasOwn(unknownSelected, 'client_info'), false);
    assert.equal(Object.hasOwn(unknownSelected, 'future_extension'), false);
    assert.deepEqual(Reflect.ownKeys(unknownSelected), [...SELECTED_KEYS]);
    assert.equal(unknownSelected.idToken, ID_TOKEN);

    for (const hostile of [
      new Proxy({}, { getPrototypeOf() { throw new Error('SECRET deps'); } }),
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('SECRET descriptor'); } }),
      { custody: new Proxy({}, { getPrototypeOf() { throw new Error('SECRET custody'); } }) },
    ]) {
      assert.throws(() => createMicrosoftTokenResponseCustodyService(hostile), (error) => error.code === FAILURE_CODE && !String(error).includes('SECRET'));
    }

    // Custody receiver preserved (this-binding) and receives exact frozen selected.
    let thisBound = false;
    let boundSelected;
    const boundAccept = async function boundAccept(value) {
      thisBound = this && this.acceptValidatedTokens === boundAccept;
      boundSelected = value;
      return Object.freeze({ status: 'accepted' });
    };
    const boundResult = await harness({}, boundAccept).exchangeAndCustody({ body: 'trusted=already-encoded' });
    assert.equal(thisBound, true);
    assert.deepEqual(boundSelected, EXPECTED_SELECTED);
    assert.deepEqual(Reflect.ownKeys(boundSelected), [...SELECTED_KEYS]);
    assert.equal(Object.isFrozen(boundSelected), true);
    assert.deepEqual(boundResult, { status: 'custodied' });
    assert.equal(Object.hasOwn(boundResult, 'idToken'), false);
    assert.equal(Object.hasOwn(boundResult, 'id_token'), false);
    assert.equal(noSecrets(boundResult), true);

    // Custody throw / unsealed ack: fixed sanitized failure, no secret leak.
    await fails({ body: JSON.stringify(GOOD) }, async () => { throw new Error(`custody leak ${REFRESH} ${ID_TOKEN}`); });
    await fails({ body: JSON.stringify(GOOD) }, async () => ({ status: 'accepted' }));

    // Happy path: idToken reaches custody only; public return is minimized ack.
    let selected;
    let acceptCalls = 0;
    const service = harness({}, async (value) => {
      acceptCalls += 1;
      selected = value;
      // Frozen snapshot — mutation must throw and must not alter custody view.
      assert.throws(() => { value.idToken = 'mutated'; });
      assert.throws(() => { value.accessToken = 'mutated'; });
      assert.throws(() => { delete value.idToken; });
      assert.throws(() => { Object.assign(value, { extra: ID_TOKEN }); });
      assert.equal(value.idToken, ID_TOKEN);
      return Object.freeze({ status: 'accepted' });
    });
    const result = await service.exchangeAndCustody({ body: 'trusted=already-encoded' });
    assert.equal(acceptCalls, 1);
    assert.deepEqual(selected, EXPECTED_SELECTED);
    assert.deepEqual(Reflect.ownKeys(selected), [...SELECTED_KEYS]);
    assert.equal(Object.isFrozen(selected), true);
    assert.equal(Object.getPrototypeOf(selected), Object.prototype);
    assert.equal(selected.idToken, ID_TOKEN);
    assert.deepEqual(result, { status: 'custodied' });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Reflect.ownKeys(result), ['status']);
    assert.equal(Object.hasOwn(result, 'idToken'), false);
    assert.equal(Object.hasOwn(result, 'accessToken'), false);
    assert.equal(Object.hasOwn(result, 'refreshToken'), false);
    assert.equal(noSecrets(result), true);

    // Single-use preserved.
    await assert.rejects(service.exchangeAndCustody({ body: 'again=x' }), (error) => error.code === FAILURE_CODE);

    // Snapshot-before-handoff: selected object handed to custody is the frozen
    // exact object produced by validation (identity + contents), not a live view
    // of raw HTTP material.
    let handoffIdentity;
    const snapService = harness({}, async (value) => {
      handoffIdentity = value;
      return Object.freeze({ status: 'accepted' });
    });
    await snapService.exchangeAndCustody({ body: 'trusted=already-encoded' });
    assert.equal(Object.isFrozen(handoffIdentity), true);
    assert.deepEqual(Reflect.ownKeys(handoffIdentity), [...SELECTED_KEYS]);
    assert.equal(handoffIdentity.idToken, ID_TOKEN);

    // No application secrets ever logged (ignore Node runtime env warnings).
    for (const entry of logged) {
      assert.equal(noSecrets(entry), true);
      const text = entry.map(String).join(' ');
      assert.equal(/ACCESS_SECRET|REFRESH_SECRET|ID_TOKEN_SECRET|id_token|idToken/.test(text), false);
    }
    assert.equal(
      logged.every((entry) => entry.map(String).join(' ').includes('Warning:')),
      true,
      'unexpected non-warning console output during custody exchange',
    );
  } finally { console.log = original; console.error = originalError; }
  original('verify:email-microsoft-response-custody-handoff: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
