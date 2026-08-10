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
    return row(fact, { label: args.lookup, secret_ref: 'hidden' });
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
  ]) await assert.rejects(() => tools.query('catalog', override), /authority_override_rejected/);

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
  for (const key of Object.keys(factual)) {
    assert.equal(ALLOWED.has(key), true, `non-allowlisted field escaped: ${key}`);
    assert.equal(FORBIDDEN.test(key), false, `sensitive field escaped: ${key}`);
  }
  assert.equal(/secret|grant|provider-id|unsafe\.invalid/.test(JSON.stringify(factual)), false);

  console.log('PASS verify-email-luna-grounded-tools');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
