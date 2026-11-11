'use strict';

const assert = require('node:assert/strict');
const {
  createMemorySupervisorStore,
  captureSupervisorEvent,
  reconcileSupervisorDeliveries,
  recordSupervisorLifecycle,
  lookupSupervisorDelivery,
} = require('./lib/staff-supervisor-events');

function hintEvent(storePatch) {
  return {
    source_key: 'staging:wolfhouse:confirmation_owed_hint:watchdog:1',
    kind: 'confirmation_owed_hint',
    obligation: 'confirmation',
    conversation_id: '11111111-1111-4111-8111-111111111111',
    booking_code: 'WH-20270703-11956801',
    ...storePatch,
  };
}

async function ackedHint(overrides = {}) {
  const store = createMemorySupervisorStore();
  const captured = await captureSupervisorEvent(store, hintEvent());
  const ackedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  Object.assign(store.events[0], {
    delivery_status: 'acked',
    acked_at: ackedAt,
    outcome: null,
    outcome_payload: {},
    metadata: {},
    ...overrides,
  });
  return { store, id: captured.row.id };
}

(async () => {
  {
    const { store } = await ackedHint();
    let writes = 0;
    const rec = await reconcileSupervisorDeliveries(store, {
      now: new Date(),
      needsHumanWriter: async () => { writes += 1; return { ok: true }; },
    });
    assert.equal(writes, 1, 'genuinely undelivered acked hint still needs human');
    assert.ok(rec.needsHuman >= 1);
  }

  {
    const { store, id } = await ackedHint();
    const life = await recordSupervisorLifecycle(store, {
      event_id: id,
      conversation_id: '11111111-1111-4111-8111-111111111111',
      user: { staff_user_id: '00000000-0000-4000-8000-000000000099', role: 'admin' },
      kind: 'stayed_out',
      env: { LUNA_SUPERVISOR_STAFF_USER_ID: '00000000-0000-4000-8000-000000000099' },
    });
    assert.equal(life.ok, true);
    assert.equal(store.events[0].outcome, 'stayed_out');
    let writes = 0;
    const rec = await reconcileSupervisorDeliveries(store, {
      now: new Date(),
      needsHumanWriter: async () => { writes += 1; return { ok: true }; },
    });
    assert.equal(writes, 0, 'stayed_out must close the hint');
    assert.equal(rec.needsHuman, 0);
  }

  {
    const { store } = await ackedHint({ outcome: 'handled' });
    let writes = 0;
    const rec = await reconcileSupervisorDeliveries(store, {
      now: new Date(),
      needsHumanWriter: async () => { writes += 1; return { ok: true }; },
    });
    assert.equal(writes, 0, 'handled outcome must close the hint');
    assert.equal(rec.needsHuman, 0);
  }

  {
    const { store } = await ackedHint();
    let writes = 0;
    const rec = await reconcileSupervisorDeliveries(store, {
      now: new Date(),
      needsHumanWriter: async () => { writes += 1; return { ok: true }; },
      deliveryLookup: async () => ({ closed: true, reason: 'luna_reply_after_hint' }),
    });
    assert.equal(writes, 0, 'a Luna reply after the hint closes it');
    assert.equal(rec.needsHuman, 0);
  }

  {
    const { store } = await ackedHint();
    store.lifecycle.push({ event_id: store.events[0].id, kind: 'stayed_out' });
    let writes = 0;
    const rec = await reconcileSupervisorDeliveries(store, {
      now: new Date(),
      needsHumanWriter: async () => { writes += 1; return { ok: true }; },
    });
    assert.equal(writes, 0, 'already-recorded stayed_out lifecycle closes even if outcome is still null');
    assert.equal(rec.needsHuman, 0);
  }

  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'lib/staff-supervisor-events.js'), 'utf8');
  assert.match(src, /stayed_out/);
  assert.match(src, /consumer_receipt/);
  assert.doesNotMatch(src, /metadata->>'consumer_receipt'\s*=\s*'true'/);

  console.log('verify-watchdog-stayed-out-closes-hint: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
