'use strict';

const assert = require('assert/strict');
const { createEmailLunaGroundedTools, MISSING_FACT, HANDOFF_REQUIRED } = require('./lib/email-luna-grounded-tools');

const AUTHORITY = Object.freeze({ client_id: 'sunset-client', location_id: 'sunset-somo' });
const FACTS = Object.freeze(['catalog', 'availability', 'policy', 'booking', 'payment']);
const ALLOWED = new Set(['type', 'fact', 'status', 'reason', 'client_id', 'location_id', 'item', 'label', 'currency', 'amount_cents', 'active', 'date', 'slot_time', 'available', 'capacity', 'policy_key', 'policy_text', 'booking_code', 'booking_status', 'check_in', 'check_out', 'guest_count', 'payment_status', 'amount_paid_cents', 'balance_due_cents']);
const FORBIDDEN = /secret|token|grant|provider|credential|password|checkout_url|session_id|payment_intent_id/i;

function row(fact, extra = {}) {
  return { fact, client_id: AUTHORITY.client_id, location_id: AUTHORITY.location_id, status: 'found', label: `${fact} fact`, ...extra };
}
function owners(overrides = {}) {
  return Object.fromEntries(FACTS.map((fact) => [fact, overrides[fact] || (async () => row(fact))]));
}

async function main() {
  const calls = [];
  const queryOwners = owners(Object.fromEntries(FACTS.map((fact) => [fact, async (scope, args) => {
    calls.push({ fact, scope, args });
    return row(fact, { label: args.lookup });
  }])));
  const tools = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners });

  assert.ok(Object.isFrozen(tools.authority), 'server authority must be immutable');
  assert.deepEqual(tools.authority, AUTHORITY);
  assert.equal('send' in tools, false, 'no send capability');
  assert.equal('write' in tools, false, 'no write capability');
  assert.deepEqual(Object.keys(tools).sort(), ['authority', 'query']);

  for (const fact of FACTS) assert.equal((await tools.query(fact, { lookup: fact })).status, 'found');
  assert.equal(calls.length, FACTS.length);
  for (const call of calls) {
    assert.deepEqual(call.scope, AUTHORITY, `${call.fact} must bind client and location`);
    assert.equal(Object.isFrozen(call.scope), true, `${call.fact} scope must be immutable`);
  }

  for (const override of [
    { client_id: 'other' }, { clientId: 'other' },
    { location_id: 'sunset-sardinero' }, { locationId: 'sunset-sardinero' },
    { authority: { ...AUTHORITY } }, { scope: { ...AUTHORITY } },
  ]) await assert.rejects(() => tools.query('catalog', override), /invalid_query_arguments/);

  for (const fact of FACTS) {
    const scoped = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ [fact]: async () => row(fact, { location_id: 'sunset-sardinero' }) }) });
    assert.deepEqual(await scoped.query(fact, {}), {
      type: HANDOFF_REQUIRED, fact, status: 'handoff_required', reason: 'authority_mismatch', ...AUTHORITY,
    });
  }

  for (const [fact, queryOwnersCase] of [
    ['unknown_fact', owners()],
    ['catalog', owners({ catalog: async () => null })],
    ['availability', owners({ availability: async () => ({ malformed: true }) })],
  ]) {
    const result = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: queryOwnersCase }).query(fact, {});
    assert.equal(result.type, MISSING_FACT);
    assert.equal(result.status, 'missing_fact');
    assert.equal(result.fact, fact);
  }

  const toolError = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ payment: async () => { throw new Error('db unavailable'); } }) }).query('payment', {});
  assert.deepEqual(toolError, { type: HANDOFF_REQUIRED, fact: 'payment', status: 'handoff_required', reason: 'tool_error', ...AUTHORITY });

  const factual = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ booking: async () => row('booking', {
    booking_code: 'SUN-42', booking_status: 'confirmed', secret_ref: 'secret', delegated_grant_id: 'grant',
    provider_message_id: 'provider-id', checkout_url: 'https://unsafe.invalid',
  }) }) }).query('booking', {});
  assert.deepEqual(factual, { type: MISSING_FACT, fact: 'booking', status: MISSING_FACT, reason: 'malformed_fact', ...AUTHORITY });
  for (const key of Object.keys(factual)) {
    assert.equal(ALLOWED.has(key), true, `non-allowlisted field escaped: ${key}`);
    assert.equal(FORBIDDEN.test(key), false, `sensitive field escaped: ${key}`);
  }
  assert.equal(/secret|grant|provider-id|unsafe\.invalid/.test(JSON.stringify(factual)), false);

  const hostileFailures = [];
  async function hostile(name, probe) {
    try {
      await probe();
    } catch (error) {
      hostileFailures.push(`${name}: ${error && error.message ? error.message : error}`);
    }
  }

  await hostile('reject every unknown or aliased input key', async () => {
    const seen = [];
    const exact = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async (_scope, args) => { seen.push(args); return row('catalog'); } }) });
    for (const args of [
      { model: 'attacker' }, { provider: 'attacker' }, { caller: 'attacker' },
      { clientAuthority: 'attacker' }, { customer_id: 'attacker' }, { site_id: 'attacker' },
      { routing: { customer_id: 'attacker' } },
    ]) await assert.rejects(() => exact.query('catalog', args), /invalid_query_arguments/);
    assert.equal(seen.length, 0);
  });

  await hostile('reject input accessors symbols and proxies without owner execution', async () => {
    let getters = 0;
    let callsMade = 0;
    const exact = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async () => { callsMade += 1; return row('catalog'); } }) });
    const accessor = {};
    Object.defineProperty(accessor, 'lookup', { enumerable: true, get() { getters += 1; return 'unsafe'; } });
    await assert.rejects(() => exact.query('catalog', accessor), /invalid_query_arguments/);
    assert.equal(getters, 0);
    await assert.rejects(() => exact.query('catalog', { lookup: 'safe', [Symbol('capability')]: () => 1 }), /invalid_query_arguments/);
    let traps = 0;
    const proxy = new Proxy({}, {
      getPrototypeOf() { traps += 1; return Object.prototype; },
      ownKeys() { traps += 1; return []; },
      getOwnPropertyDescriptor() { traps += 1; return undefined; },
    });
    await assert.rejects(() => exact.query('catalog', proxy), /invalid_query_arguments/);
    assert.equal(callsMade, 0);
    assert.equal(traps, 0, 'transparent request Proxy must be rejected before reflection');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    await assert.rejects(() => exact.query('catalog', revoked.proxy), /invalid_query_arguments/);
    assert.equal(callsMade, 0);
  });

  await hostile('reject owner map proxies before reflection or owner execution', async () => {
    let traps = 0;
    let callsMade = 0;
    const target = owners({ catalog: async () => { callsMade += 1; return row('catalog'); } });
    const proxy = new Proxy(target, {
      getPrototypeOf() { traps += 1; return Object.prototype; },
      ownKeys() { traps += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(_value, key) { traps += 1; return Object.getOwnPropertyDescriptor(target, key); },
    });
    assert.throws(() => createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: proxy }), /invalid_grounded_tools_configuration/);
    assert.equal(traps, 0, 'transparent owner map Proxy must be rejected before reflection');
    assert.equal(callsMade, 0);
    const revoked = Proxy.revocable(target, {});
    revoked.revoke();
    assert.throws(() => createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: revoked.proxy }), /invalid_grounded_tools_configuration/);
    assert.equal(callsMade, 0);
  });

  await hostile('reject owner wrapper and row proxies before module reflection', async () => {
    for (const shape of ['wrapper', 'row']) {
      let thenGets = 0;
      let reflectionTraps = 0;
      let callsMade = 0;
      const target = shape === 'wrapper' ? { rows: [row('catalog')] } : row('catalog');
      const proxy = new Proxy(target, {
        get(value, key, receiver) {
          if (key === 'then') thenGets += 1;
          return Reflect.get(value, key, receiver);
        },
        getPrototypeOf() { reflectionTraps += 1; return Object.prototype; },
        ownKeys() { reflectionTraps += 1; return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(_value, key) { reflectionTraps += 1; return Object.getOwnPropertyDescriptor(target, key); },
      });
      const result = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async () => { callsMade += 1; return proxy; } }) }).query('catalog', {});
      assert.deepEqual(result, { type: MISSING_FACT, fact: 'catalog', status: MISSING_FACT, reason: 'malformed_fact', ...AUTHORITY });
      assert.equal(callsMade, 1);
      assert.equal(thenGets, 1, `native Promise assimilation must perform exactly one unavoidable then probe for owner ${shape} Proxy`);
      assert.equal(reflectionTraps, 0, `module must reject owner ${shape} Proxy before any subsequent reflection`);
      assert.equal(JSON.stringify(result).includes('unsafe'), false, 'Proxy data/capabilities must not leak');

      const revoked = Proxy.revocable(target, {});
      revoked.revoke();
      const revokedResult = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async () => revoked.proxy }) }).query('catalog', {});
      assert.deepEqual(revokedResult, { type: HANDOFF_REQUIRED, fact: 'catalog', status: HANDOFF_REQUIRED, reason: 'tool_error', ...AUTHORITY });
    }
  });

  await hostile('retain the privately captured proxy detector after monkeypatch', async () => {
    const utilTypes = require('node:util').types;
    const original = utilTypes.isProxy;
    let traps = 0;
    let callsMade = 0;
    const proxy = new Proxy({}, { getPrototypeOf() { traps += 1; return Object.prototype; } });
    try {
      utilTypes.isProxy = () => false;
      const exact = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async () => { callsMade += 1; return row('catalog'); } }) });
      await assert.rejects(() => exact.query('catalog', proxy), /invalid_query_arguments/);
    } finally {
      utilTypes.isProxy = original;
    }
    assert.equal(traps, 0);
    assert.equal(callsMade, 0);
  });

  await hostile('ignore post-import Array iterator monkeypatches', async () => {
    const original = Array.prototype[Symbol.iterator];
    const exact = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({
      catalog: async () => row('catalog', { item: 'safe-item' }),
    }) });
    let iteratorCalls = 0;
    try {
      Array.prototype[Symbol.iterator] = function hostileIterator() {
        iteratorCalls += 1;
        return original.call(this);
      };
      const result = await exact.query('catalog', {});
      assert.equal(result.item, 'safe-item');
    } finally {
      Array.prototype[Symbol.iterator] = original;
    }
    assert.equal(iteratorCalls, 0, 'module must not execute the ambient Array iterator');
  });

  await hostile('ignore post-import Object prototype framework-key setters', async () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'label');
    let setterCalls = 0;
    let result;
    try {
      Object.defineProperty(Object.prototype, 'label', {
        configurable: true,
        set() { setterCalls += 1; },
      });
      result = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners() }).query('catalog', {});
    } finally {
      if (original) Object.defineProperty(Object.prototype, 'label', original);
      else delete Object.prototype.label;
    }
    assert.equal(setterCalls, 0, 'record construction must not execute Object.prototype setters');
    assert.deepEqual(result, row('catalog'));
  });

  await hostile('snapshot and freeze request before await', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let observed;
    const input = { lookup: 'before' };
    const exact = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async (_scope, args) => { await gate; observed = args; return row('catalog'); } }) });
    const pending = exact.query('catalog', input);
    input.lookup = 'after';
    input.extra = () => 'capability';
    release();
    await pending;
    assert.notEqual(observed, input);
    assert.deepEqual(observed, { lookup: 'before' });
    assert.equal(Object.isFrozen(observed), true);
  });

  await hostile('pin exact own-data owner functions at construction', async () => {
    let originalCalls = 0;
    let replacementCalls = 0;
    const queryOwnersCase = owners({ catalog: async () => { originalCalls += 1; return row('catalog'); } });
    const exact = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: queryOwnersCase });
    queryOwnersCase.catalog = async () => { replacementCalls += 1; return row('catalog'); };
    await exact.query('catalog', {});
    assert.equal(originalCalls, 1);
    assert.equal(replacementCalls, 0);
    let getterCalls = 0;
    const accessorOwners = owners();
    Object.defineProperty(accessorOwners, 'catalog', { enumerable: true, get() { getterCalls += 1; return async () => row('catalog'); } });
    assert.throws(() => createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: accessorOwners }), /invalid_grounded_tools_configuration/);
    assert.equal(getterCalls, 0);
  });

  await hostile('reserve response semantics and enforce exact row schema', async () => {
    const forged = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async () => row('catalog', { type: HANDOFF_REQUIRED, reason: 'forged', extra: 'unknown' }) }) }).query('catalog', {});
    assert.deepEqual(forged, { type: MISSING_FACT, fact: 'catalog', status: MISSING_FACT, reason: 'malformed_fact', ...AUTHORITY });
  });

  await hostile('parse wrappers and rows descriptor-safely', async () => {
    let wrapperGets = 0;
    const wrapper = {};
    Object.defineProperty(wrapper, 'rows', { enumerable: true, get() { wrapperGets += 1; return [row('catalog')]; } });
    const wrapperResult = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async () => wrapper }) }).query('catalog', {});
    assert.deepEqual(wrapperResult, { type: MISSING_FACT, fact: 'catalog', status: MISSING_FACT, reason: 'malformed_fact', ...AUTHORITY });
    assert.equal(wrapperGets, 0);
    let rowGets = 0;
    const accessorRow = row('catalog');
    Object.defineProperty(accessorRow, 'label', { enumerable: true, get() { rowGets += 1; return 'unsafe'; } });
    await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async () => accessorRow }) }).query('catalog', {});
    assert.equal(rowGets, 0);
  });

  await hostile('reject thenable non-native and malformed owner results', async () => {
    let thenGets = 0;
    const thenable = {};
    Object.defineProperty(thenable, 'then', { get() { thenGets += 1; return (resolve) => resolve(row('catalog')); } });
    const exact = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: () => thenable }) });
    assert.deepEqual(await exact.query('catalog', {}), { type: HANDOFF_REQUIRED, fact: 'catalog', status: HANDOFF_REQUIRED, reason: 'tool_error', ...AUTHORITY });
    assert.equal(thenGets, 0);
    for (const malformed of [Promise.resolve(), Promise.resolve(() => 1), Promise.resolve({ rows: [row('catalog')], extra: true })]) {
      const result = await createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: () => malformed }) }).query('catalog', {});
      assert.equal(result.type, MISSING_FACT);
    }
  });

  await hostile('deep-freeze every success and failure DTO', async () => {
    const exact = createEmailLunaGroundedTools({ authority: AUTHORITY, queryOwners: owners({ catalog: async () => ({ rows: [row('catalog')] }) }) });
    const success = await exact.query('catalog', {});
    const failure = await exact.query('unknown', {});
    assert.equal(Object.isFrozen(success), true);
    assert.equal(Object.isFrozen(success.rows), true);
    assert.equal(Object.isFrozen(success.rows[0]), true);
    assert.equal(Object.isFrozen(failure), true);
    assert.throws(() => { success.rows[0].label = 'mutated'; }, TypeError);
    assert.throws(() => { failure.reason = 'mutated'; }, TypeError);
  });

  assert.deepEqual(hostileFailures, [], `hostile regressions:\n${hostileFailures.join('\n')}`);
  console.log('PASS verify-email-luna-grounded-tools');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
