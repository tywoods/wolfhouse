'use strict';

/**
 * Session advisory unlock safety — pinned PoolClient, unlock=true required,
 * poison + withPgClient release(true). Offline. No live DB.
 *
 * Run: node scripts/verify-sunset-session-advisory-unlock.js
 */

const assert = require('assert');
const {
  withPgClient,
  markPgClientDiscardRequired,
  isPgClientDiscardRequired,
  assertPinnedPgClientForSessionAdvisoryLock,
  PG_CLIENT_DISCARD_REQUIRED,
  _setPoolForTests,
  _getPoolForTests,
} = require('./lib/pg-connect');
const {
  acquireIdempotencySessionLock,
  releaseIdempotencySessionLock,
  readAdvisoryUnlockBoolean,
  scheduleBookingIdempotencySessionKeys,
} = require('./lib/sunset-schedule-booking-writes');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function makePinnedClient(opts = {}) {
  const state = {
    queries: [],
    unlockResult: opts.unlockResult !== undefined ? opts.unlockResult : true,
    unlockThrow: opts.unlockThrow || null,
    lockThrow: opts.lockThrow || null,
    unlockAllCalls: 0,
  };
  const client = {
    release() { /* PoolClient shape */ },
    async query(sql, params) {
      const q = String(sql);
      state.queries.push({ q, params: params || [] });
      if (/pg_advisory_lock\b/i.test(q) && !/unlock/i.test(q)) {
        if (state.lockThrow) throw state.lockThrow;
        return { rows: [{ pg_advisory_lock: '' }] };
      }
      if (/pg_advisory_unlock_all\b/i.test(q)) {
        state.unlockAllCalls += 1;
        return { rows: [{ pg_advisory_unlock_all: '' }] };
      }
      if (/pg_advisory_unlock\b/i.test(q)) {
        if (state.unlockThrow) throw state.unlockThrow;
        if (state.unlockResult === null) {
          return { rows: [{}] };
        }
        return { rows: [{ unlocked: state.unlockResult }] };
      }
      return { rows: [] };
    },
  };
  return { client, state };
}

async function main() {
  console.log('verify-sunset-session-advisory-unlock\n');

  // ── readAdvisoryUnlockBoolean ──
  ok('unlock true via unlocked alias',
    readAdvisoryUnlockBoolean({ rows: [{ unlocked: true }] }) === true);
  ok('unlock false via unlocked alias',
    readAdvisoryUnlockBoolean({ rows: [{ unlocked: false }] }) === false);
  ok('unlock true via function column name',
    readAdvisoryUnlockBoolean({ rows: [{ pg_advisory_unlock: true }] }) === true);
  ok('unlock null on empty',
    readAdvisoryUnlockBoolean({ rows: [] }) === null);

  // ── assertPinnedPgClientForSessionAdvisoryLock ──
  {
    let threw = null;
    try {
      assertPinnedPgClientForSessionAdvisoryLock({
        connect: async () => ({}),
        query: async () => ({ rows: [] }),
      });
    } catch (e) { threw = e; }
    ok('Pool facade (connect, no release) rejected',
      threw && threw.reason_code === 'session_advisory_lock_rejects_pool',
      threw && threw.message);
    threw = null;
    try {
      assertPinnedPgClientForSessionAdvisoryLock(null);
    } catch (e) { threw = e; }
    ok('null client rejected',
      threw && threw.reason_code === 'session_advisory_lock_requires_pinned_client');
    threw = null;
    try {
      assertPinnedPgClientForSessionAdvisoryLock(makePinnedClient().client);
    } catch (e) { threw = e; }
    ok('pinned client with release() accepted', threw == null);
  }

  // ── acquire rejects pool before lock query ──
  {
    let lockSql = 0;
    const poolFacade = {
      connect: async () => ({}),
      async query() {
        lockSql += 1;
        return { rows: [] };
      },
    };
    let threw = null;
    try {
      await acquireIdempotencySessionLock(poolFacade, 'sunset', 'k1');
    } catch (e) { threw = e; }
    ok('acquire rejects pool before acquisition',
      threw && threw.reason_code === 'session_advisory_lock_rejects_pool');
    ok('acquire did not run lock SQL on pool', lockSql === 0);
  }

  // ── same pinned object receives lock + unlock ──
  {
    const { client, state } = makePinnedClient();
    const handle = await acquireIdempotencySessionLock(client, 'sunset', 'pin-test');
    ok('handle.client is same object', handle.client === client);
    ok('lock SQL ran on pinned client',
      state.queries.some((x) => /pg_advisory_lock/.test(x.q)));
    await releaseIdempotencySessionLock(client, handle);
    ok('unlock SQL ran on same client',
      state.queries.some((x) => /pg_advisory_unlock\(\$1/.test(x.q) || /AS unlocked/.test(x.q)));
    ok('unlock true path does not poison', !isPgClientDiscardRequired(client));
  }

  // ── unlock true is normal ──
  {
    const { client, state } = makePinnedClient({ unlockResult: true });
    const handle = await acquireIdempotencySessionLock(client, 'sunset', 'ok');
    await releaseIdempotencySessionLock(client, handle);
    ok('unlock true: no unlock_all', state.unlockAllCalls === 0);
    ok('unlock true: not poisoned', !isPgClientDiscardRequired(client));
  }

  // ── unlock false throws + poison + unlock_all attempt ──
  {
    const { client, state } = makePinnedClient({ unlockResult: false });
    const handle = await acquireIdempotencySessionLock(client, 'sunset', 'false');
    let threw = null;
    try {
      await releaseIdempotencySessionLock(client, handle);
    } catch (e) { threw = e; }
    ok('unlock false throws', threw && threw.reason_code === 'session_advisory_unlock_not_held');
    ok('unlock false poisons client', isPgClientDiscardRequired(client));
    ok('unlock false attempted unlock_all', state.unlockAllCalls === 1);
  }

  // ── unlock exception throws + poison ──
  {
    const { client, state } = makePinnedClient({
      unlockThrow: new Error('network blip'),
    });
    const handle = await acquireIdempotencySessionLock(client, 'sunset', 'exc');
    let threw = null;
    try {
      await releaseIdempotencySessionLock(client, handle);
    } catch (e) { threw = e; }
    ok('unlock exception throws',
      threw && threw.reason_code === 'session_advisory_unlock_failed');
    ok('unlock exception poisons client', isPgClientDiscardRequired(client));
    ok('unlock exception attempted unlock_all', state.unlockAllCalls === 1);
  }

  // ── client mismatch on unlock ──
  {
    const a = makePinnedClient();
    const b = makePinnedClient();
    const handle = await acquireIdempotencySessionLock(a.client, 'sunset', 'mis');
    let threw = null;
    try {
      await releaseIdempotencySessionLock(b.client, handle);
    } catch (e) { threw = e; }
    ok('client mismatch throws',
      threw && threw.reason_code === 'session_advisory_unlock_client_mismatch');
    ok('mismatch poisons unlock target', isPgClientDiscardRequired(b.client));
  }

  // ── withPgClient: release(true) for poisoned, normal otherwise ──
  {
    const prev = _getPoolForTests();
    const releases = [];
    const fakeClient = {
      release(destroy) { releases.push(destroy === true ? 'destroy' : 'normal'); },
      async query() { return { rows: [] }; },
    };
    const fakePool = {
      async connect() { return fakeClient; },
    };
    _setPoolForTests(fakePool);
    try {
      await withPgClient(async (c) => {
        ok('withPgClient supplies same connect() client', c === fakeClient);
        return 'ok';
      });
      ok('healthy path uses normal release',
        releases.length === 1 && releases[0] === 'normal');

      releases.length = 0;
      let threw = null;
      try {
        await withPgClient(async (c) => {
          markPgClientDiscardRequired(c);
          return 'poisoned-work';
        });
      } catch (e) { threw = e; }
      ok('poisoned path does not throw from withPgClient', threw == null);
      ok('poisoned path uses release(true)',
        releases.length === 1 && releases[0] === 'destroy',
        JSON.stringify(releases));
    } finally {
      _setPoolForTests(prev);
    }
  }

  // ── Symbol is shared ──
  ok('PG_CLIENT_DISCARD_REQUIRED is Symbol.for shared key',
    PG_CLIENT_DISCARD_REQUIRED === Symbol.for('wolfhouse.pgClient.discardRequired'));

  // ── session keys deterministic ──
  {
    const a = scheduleBookingIdempotencySessionKeys('sunset', 'k');
    const b = scheduleBookingIdempotencySessionKeys('sunset', 'k');
    ok('session keys stable', a[0] === b[0] && a[1] === b[1]);
  }

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
