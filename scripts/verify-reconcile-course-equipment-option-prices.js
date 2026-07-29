'use strict';

/**
 * Focused verifier — reconcile-course-equipment-option-prices fail-closed contract.
 *
 * Pure transform + injected fake-pg only. Never opens a real database.
 *
 * Proves:
 *   1. Mixed/malformed rows preserve the original array (changed:false).
 *   2. One bad config blocks UPDATEs to another good config (whole-batch).
 *   3. Mid-update failure rolls back prior updates in the same transaction.
 *   4. Clean apply updates both pack + private tables and commits.
 *   5. Second apply is idempotent (zero changes).
 *   6. Already-canonical JSONB key order is idempotent (no false changed).
 */

const assert = require('assert');
const {
  reconcileEquipmentOptionsArray,
  equipmentOptionsSemanticallyEqual,
  dryRunOrApply,
  selfCheck,
} = require('./reconcile-course-equipment-option-prices');

const LEGACY_SOFTBOARD = {
  offering_key: 'softboard',
  equipment_price_cents: 500,
  all_day_surcharge_cents: 1000,
};
const CANONICAL_SOFTBOARD = {
  offering_key: 'softboard',
  during_course_price_cents: 500,
  all_day_price_cents: 1000,
};
/** Postgres JSONB key order (alphabetical) — differs from normalizer insertion order. */
const JSONB_CANONICAL_SOFTBOARD = JSON.parse(
  '{"all_day_price_cents":1000,"during_course_price_cents":500,"offering_key":"softboard"}',
);
const JSONB_CANONICAL_WETSUIT = JSON.parse(
  '{"all_day_price_cents":1200,"during_course_price_cents":700,"offering_key":"wetsuit"}',
);
const MIXED_ROW = {
  offering_key: 'broken',
  equipment_price_cents: 1,
  during_course_price_cents: 1,
  all_day_price_cents: 1,
  all_day_surcharge_cents: 1,
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Minimal injectable pg stand-in.
 * Supports Pool-style .connect() → client with .query/.release, plus direct .query.
 */
function makeFakePg(seed = {}) {
  const state = {
    packs: deepClone(seed.packs || []),
    privates: deepClone(seed.privates || []),
    queries: [],
    begins: 0,
    commits: 0,
    rollbacks: 0,
    updates: 0,
    failOnUpdateIndex: seed.failOnUpdateIndex == null ? null : seed.failOnUpdateIndex,
    lockedPackIds: [],
    lockedPrivateIds: [],
  };
  let snapshot = null;

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push({ text, params: params.slice() });

    if (/^BEGIN$/i.test(text)) {
      state.begins += 1;
      snapshot = {
        packs: deepClone(state.packs),
        privates: deepClone(state.privates),
      };
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(text)) {
      state.commits += 1;
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(text)) {
      state.rollbacks += 1;
      if (snapshot) {
        state.packs = snapshot.packs;
        state.privates = snapshot.privates;
        snapshot = null;
      }
      return { rows: [], rowCount: 0 };
    }

    if (/FROM tenant_surf_pack_rules/i.test(text)) {
      const rows = state.packs
        .slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((row) => ({
          id: String(row.id),
          client_slug: row.client_slug || 'sunset',
          location_id: row.location_id || 'sunset-somo',
          config_json: deepClone(row.config_json),
        }));
      if (/FOR UPDATE/i.test(text)) {
        state.lockedPackIds = rows.map((r) => r.id);
      }
      return { rows, rowCount: rows.length };
    }

    if (/FROM tenant_private_lesson_rules/i.test(text)) {
      const rows = state.privates
        .slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((row) => ({
          id: String(row.id),
          client_slug: row.client_slug || 'sunset',
          location_id: row.location_id || 'sunset-somo',
          config_json: deepClone(row.config_json),
        }));
      if (/FOR UPDATE/i.test(text)) {
        state.lockedPrivateIds = rows.map((r) => r.id);
      }
      return { rows, rowCount: rows.length };
    }

    if (/UPDATE tenant_surf_pack_rules/i.test(text)) {
      state.updates += 1;
      if (state.failOnUpdateIndex != null && state.updates === state.failOnUpdateIndex) {
        throw new Error('forced_update_failure');
      }
      const id = String(params[1]);
      const next = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0];
      const row = state.packs.find((p) => String(p.id) === id);
      assert.ok(row, `pack ${id} missing for update`);
      row.config_json = next;
      return { rows: [], rowCount: 1 };
    }

    if (/UPDATE tenant_private_lesson_rules/i.test(text)) {
      state.updates += 1;
      if (state.failOnUpdateIndex != null && state.updates === state.failOnUpdateIndex) {
        throw new Error('forced_update_failure');
      }
      const id = String(params[1]);
      const next = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0];
      const row = state.privates.find((p) => String(p.id) === id);
      assert.ok(row, `private ${id} missing for update`);
      row.config_json = next;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unhandled fake pg query: ${text.slice(0, 160)}`);
  }

  const client = {
    query,
    release() { state.released = true; },
  };

  return {
    state,
    query,
    async connect() {
      state.connected = (state.connected || 0) + 1;
      return client;
    },
  };
}

function testPureTransform() {
  // Mixed row preserves original (reference + deep).
  const mixedArr = [MIXED_ROW];
  const mixed = reconcileEquipmentOptionsArray(mixedArr);
  assert.strictEqual(mixed.changed, false, 'mixed: changed false');
  assert.strictEqual(mixed.options, mixedArr, 'mixed: same array reference');
  assert.deepStrictEqual(mixed.options, [MIXED_ROW], 'mixed: deep-equivalent original');
  assert.ok(mixed.errors.some((e) => String(e).includes('mixed_schema')));

  // Good + bad together: no partial rewrite of the good legacy row.
  const both = [LEGACY_SOFTBOARD, MIXED_ROW];
  const bothSnap = deepClone(both);
  const bothResult = reconcileEquipmentOptionsArray(both);
  assert.strictEqual(bothResult.changed, false);
  assert.strictEqual(bothResult.options, both);
  assert.deepStrictEqual(both, bothSnap, 'original array content must not mutate');
  assert.ok(!bothResult.options.some((r) => r && r.during_course_price_cents === 500
    && !Object.prototype.hasOwnProperty.call(r, 'equipment_price_cents')),
  'must not emit partial rewritten options when any row is bad');

  // Clean legacy rewrite.
  const legacyOnly = [deepClone(LEGACY_SOFTBOARD)];
  const legacyResult = reconcileEquipmentOptionsArray(legacyOnly);
  assert.strictEqual(legacyResult.changed, true);
  assert.deepStrictEqual(legacyResult.options, [CANONICAL_SOFTBOARD]);
  assert.deepStrictEqual(legacyResult.errors, []);

  // not_an_array fail-closed.
  const rawObj = { not: 'array' };
  const badType = reconcileEquipmentOptionsArray(rawObj);
  assert.strictEqual(badType.changed, false);
  assert.strictEqual(badType.options, rawObj);
  assert.deepStrictEqual(badType.errors, ['not_an_array']);

  // JSONB alphabetical key order must not false-positive as changed.
  assert.notStrictEqual(
    JSON.stringify([JSONB_CANONICAL_SOFTBOARD]),
    JSON.stringify([CANONICAL_SOFTBOARD]),
    'fixture must demonstrate key-order divergence from insertion-order canonical',
  );
  const jsonbArr = [deepClone(JSONB_CANONICAL_SOFTBOARD), deepClone(JSONB_CANONICAL_WETSUIT)];
  const jsonbResult = reconcileEquipmentOptionsArray(jsonbArr);
  assert.strictEqual(jsonbResult.changed, false, 'jsonb-key-order canonical: changed false');
  assert.strictEqual(jsonbResult.options, jsonbArr, 'jsonb-key-order: keep original ref');
  assert.deepStrictEqual(jsonbResult.errors, []);
  assert.ok(
    equipmentOptionsSemanticallyEqual(jsonbArr, [
      CANONICAL_SOFTBOARD,
      {
        offering_key: 'wetsuit',
        during_course_price_cents: 700,
        all_day_price_cents: 1200,
      },
    ]),
    'jsonb and insertion-order canonical must be semantically equal',
  );

  // Array order is semantic — different order is not equal.
  assert.strictEqual(
    equipmentOptionsSemanticallyEqual(
      [JSONB_CANONICAL_WETSUIT, JSONB_CANONICAL_SOFTBOARD],
      [CANONICAL_SOFTBOARD, {
        offering_key: 'wetsuit',
        during_course_price_cents: 700,
        all_day_price_cents: 1200,
      }],
    ),
    false,
    'swapped option order must not be semantically equal',
  );

  // Amount difference is meaningful.
  const amountDiff = reconcileEquipmentOptionsArray([{
    offering_key: 'softboard',
    during_course_price_cents: 999,
    all_day_price_cents: 1000,
  }]);
  // Already-canonical with different amounts still "unchanged" vs its own normalize
  // (idempotent: rewrite only when schema/order/identity/amounts need transform).
  assert.strictEqual(amountDiff.changed, false, 'pure canonical amount is stable vs self');
  assert.strictEqual(amountDiff.errors.length, 0);

  console.log('  pure transform: OK');
}

async function testBadConfigBlocksGood() {
  const goodPack = {
    id: '11111111-1111-4111-8111-111111111111',
    config_json: {
      label: 'Good Pack',
      group_size: 8,
      equipment_options: [deepClone(LEGACY_SOFTBOARD)],
      keep_me: true,
    },
  };
  const badPrivate = {
    id: '22222222-2222-4222-8222-222222222222',
    config_json: {
      amount_cents: 6000,
      equipment_options: [deepClone(MIXED_ROW)],
      keep_private: true,
    },
  };
  const beforePack = deepClone(goodPack.config_json);
  const beforePrivate = deepClone(badPrivate.config_json);

  const pg = makeFakePg({ packs: [goodPack], privates: [badPrivate] });
  const report = await dryRunOrApply(pg, { apply: true });

  assert.strictEqual(report.blocked, true, 'must block on any error');
  assert.strictEqual(report.committed, false, 'must not commit when blocked');
  assert.strictEqual(report.rolled_back, true, 'must rollback when blocked under --apply');
  assert.ok(report.errors.length >= 1);
  assert.strictEqual(pg.state.updates, 0, 'zero UPDATEs when any config is bad');
  assert.strictEqual(pg.state.commits, 0);
  assert.ok(pg.state.begins >= 1, 'apply must open a transaction');
  assert.ok(pg.state.rollbacks >= 1);
  assert.deepStrictEqual(
    pg.state.lockedPackIds,
    [goodPack.id],
    'pack candidates locked FOR UPDATE',
  );
  assert.deepStrictEqual(
    pg.state.lockedPrivateIds,
    [badPrivate.id],
    'private candidates locked FOR UPDATE',
  );
  // Good pack must remain legacy (not rewritten) because batch blocked.
  assert.deepStrictEqual(pg.state.packs[0].config_json, beforePack);
  assert.deepStrictEqual(pg.state.privates[0].config_json, beforePrivate);
  // Non-equipment fields untouched.
  assert.strictEqual(pg.state.packs[0].config_json.keep_me, true);
  assert.strictEqual(pg.state.packs[0].config_json.group_size, 8);

  console.log('  bad config blocks good: OK');
}

async function testMidUpdateRollback() {
  const pack = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    config_json: {
      equipment_options: [deepClone(LEGACY_SOFTBOARD)],
      keep_pack: 'pack-meta',
    },
  };
  const priv = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    config_json: {
      equipment_options: [deepClone(LEGACY_SOFTBOARD)],
      keep_private: 'private-meta',
    },
  };
  const beforePack = deepClone(pack.config_json);
  const beforePrivate = deepClone(priv.config_json);

  // Fail on the second UPDATE (after first succeeds inside the txn).
  const pg = makeFakePg({
    packs: [pack],
    privates: [priv],
    failOnUpdateIndex: 2,
  });

  let threw = null;
  try {
    await dryRunOrApply(pg, { apply: true });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'mid-update failure must throw');
  assert.match(String(threw.message || threw), /forced_update_failure/);
  assert.ok(pg.state.begins >= 1);
  assert.ok(pg.state.rollbacks >= 1, 'must ROLLBACK after update failure');
  assert.strictEqual(pg.state.commits, 0, 'must not COMMIT after update failure');
  // Snapshot restore: both tables back to pre-txn state.
  assert.deepStrictEqual(pg.state.packs[0].config_json, beforePack);
  assert.deepStrictEqual(pg.state.privates[0].config_json, beforePrivate);
  assert.strictEqual(pg.state.packs[0].config_json.keep_pack, 'pack-meta');
  assert.strictEqual(pg.state.privates[0].config_json.keep_private, 'private-meta');

  console.log('  mid-update rollback: OK');
}

async function testCleanApplyAndIdempotentSecond() {
  const pack = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    config_json: {
      equipment_options: [deepClone(LEGACY_SOFTBOARD)],
      group_size: 6,
      label: 'Legacy Pack',
    },
  };
  const priv = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    config_json: {
      equipment_options: [deepClone(LEGACY_SOFTBOARD)],
      amount_cents: 7000,
      label: 'Legacy Private',
    },
  };

  const pg = makeFakePg({ packs: [pack], privates: [priv] });

  // Dry-run first: no writes.
  const dry = await dryRunOrApply(pg, { apply: false });
  assert.strictEqual(dry.apply, false);
  assert.strictEqual(dry.blocked, false);
  assert.strictEqual(dry.packs_changed, 1);
  assert.strictEqual(dry.private_changed, 1);
  assert.strictEqual(pg.state.begins, 0, 'dry-run must not BEGIN');
  assert.strictEqual(pg.state.updates, 0, 'dry-run must not UPDATE');
  assert.ok(
    pg.state.queries.every((q) => !/FOR UPDATE/i.test(q.text)),
    'dry-run must not FOR UPDATE',
  );
  // Still legacy after dry-run.
  assert.ok(
    Object.prototype.hasOwnProperty.call(
      pg.state.packs[0].config_json.equipment_options[0],
      'equipment_price_cents',
    ),
  );

  // Clean apply: both tables rewritten + commit.
  const apply1 = await dryRunOrApply(pg, { apply: true });
  assert.strictEqual(apply1.blocked, false);
  assert.strictEqual(apply1.committed, true);
  assert.strictEqual(apply1.packs_changed, 1);
  assert.strictEqual(apply1.private_changed, 1);
  assert.strictEqual(pg.state.commits, 1);
  assert.strictEqual(pg.state.rollbacks, 0);
  assert.ok(pg.state.updates >= 2, 'both tables updated');
  assert.deepStrictEqual(
    pg.state.packs[0].config_json.equipment_options,
    [CANONICAL_SOFTBOARD],
  );
  assert.deepStrictEqual(
    pg.state.privates[0].config_json.equipment_options,
    [CANONICAL_SOFTBOARD],
  );
  // Preserve non-equipment config fields.
  assert.strictEqual(pg.state.packs[0].config_json.group_size, 6);
  assert.strictEqual(pg.state.packs[0].config_json.label, 'Legacy Pack');
  assert.strictEqual(pg.state.privates[0].config_json.amount_cents, 7000);
  assert.strictEqual(pg.state.privates[0].config_json.label, 'Legacy Private');

  // Second apply: idempotent, zero changes, still clean commit path.
  const updatesBefore = pg.state.updates;
  const apply2 = await dryRunOrApply(pg, { apply: true });
  assert.strictEqual(apply2.blocked, false);
  assert.strictEqual(apply2.committed, true);
  assert.strictEqual(apply2.packs_changed, 0, 'second apply: packs_changed 0');
  assert.strictEqual(apply2.private_changed, 0, 'second apply: private_changed 0');
  assert.strictEqual(pg.state.updates, updatesBefore, 'second apply issues zero UPDATEs');
  assert.deepStrictEqual(
    pg.state.packs[0].config_json.equipment_options,
    [CANONICAL_SOFTBOARD],
  );
  assert.deepStrictEqual(
    pg.state.privates[0].config_json.equipment_options,
    [CANONICAL_SOFTBOARD],
  );

  console.log('  clean apply + idempotent second: OK');
}

/**
 * Regression: live staging false idempotence — after apply, Postgres returns
 * already-canonical rows with alphabetical JSONB key order. Dry-run and second
 * apply must report zero updates (not all-changed).
 */
async function testJsonbKeyOrderIdempotentDryAndSecondRun() {
  // Seed 3 pack + 1 private already-canonical rows with JSONB-style key order
  // (alphabetical), matching the live post-apply shape.
  const packs = [
    {
      id: 'e1111111-1111-4111-8111-111111111111',
      config_json: {
        label: 'Pack A',
        equipment_options: [deepClone(JSONB_CANONICAL_SOFTBOARD)],
      },
    },
    {
      id: 'e2222222-2222-4222-8222-222222222222',
      config_json: {
        label: 'Pack B',
        equipment_options: [
          deepClone(JSONB_CANONICAL_SOFTBOARD),
          deepClone(JSONB_CANONICAL_WETSUIT),
        ],
      },
    },
    {
      id: 'e3333333-3333-4333-8333-333333333333',
      config_json: {
        label: 'Pack C',
        equipment_options: [deepClone(JSONB_CANONICAL_WETSUIT)],
      },
    },
  ];
  const privates = [
    {
      id: 'e4444444-4444-4444-8444-444444444444',
      config_json: {
        label: 'Private A',
        amount_cents: 8000,
        equipment_options: [deepClone(JSONB_CANONICAL_SOFTBOARD)],
      },
    },
  ];

  const pg = makeFakePg({ packs, privates });

  // Dry-run on stored canonical JSONB: zero changes.
  const dry = await dryRunOrApply(pg, { apply: false });
  assert.strictEqual(dry.blocked, false, 'jsonb dry-run: not blocked');
  assert.strictEqual(dry.packs_scanned, 3);
  assert.strictEqual(dry.private_scanned, 1);
  assert.strictEqual(dry.packs_changed, 0, 'jsonb dry-run: packs_changed 0');
  assert.strictEqual(dry.private_changed, 0, 'jsonb dry-run: private_changed 0');
  assert.strictEqual(pg.state.updates, 0);
  assert.strictEqual(pg.state.begins, 0);

  // Apply on already-canonical JSONB: commit path with zero UPDATEs.
  const apply1 = await dryRunOrApply(pg, { apply: true });
  assert.strictEqual(apply1.blocked, false);
  assert.strictEqual(apply1.committed, true);
  assert.strictEqual(apply1.packs_changed, 0, 'jsonb apply: packs_changed 0');
  assert.strictEqual(apply1.private_changed, 0, 'jsonb apply: private_changed 0');
  assert.strictEqual(pg.state.updates, 0, 'jsonb apply issues zero UPDATEs');
  // Original JSONB key order preserved (no rewrite).
  assert.deepStrictEqual(
    Object.keys(pg.state.packs[0].config_json.equipment_options[0]),
    ['all_day_price_cents', 'during_course_price_cents', 'offering_key'],
  );

  // Second dry + apply still zero.
  const dry2 = await dryRunOrApply(pg, { apply: false });
  assert.strictEqual(dry2.packs_changed, 0);
  assert.strictEqual(dry2.private_changed, 0);
  const apply2 = await dryRunOrApply(pg, { apply: true });
  assert.strictEqual(apply2.packs_changed, 0);
  assert.strictEqual(apply2.private_changed, 0);
  assert.strictEqual(pg.state.updates, 0);

  console.log('  jsonb key-order idempotent dry/second: OK');
}

/**
 * Prove legacy still rewrites under the semantic comparator, then the
 * post-apply (insertion-order) shape is stable on second dry-run.
 */
async function testLegacyStillChangesThenStable() {
  const pack = {
    id: 'f1111111-1111-4111-8111-111111111111',
    config_json: { equipment_options: [deepClone(LEGACY_SOFTBOARD)] },
  };
  const pg = makeFakePg({ packs: [pack], privates: [] });

  const dryLegacy = await dryRunOrApply(pg, { apply: false });
  assert.strictEqual(dryLegacy.packs_changed, 1, 'legacy dry-run must report changed');

  const apply1 = await dryRunOrApply(pg, { apply: true });
  assert.strictEqual(apply1.packs_changed, 1);
  assert.strictEqual(apply1.committed, true);
  assert.deepStrictEqual(
    pg.state.packs[0].config_json.equipment_options,
    [CANONICAL_SOFTBOARD],
  );

  // Simulate Postgres re-read: rewrite stored options with JSONB key order.
  pg.state.packs[0].config_json.equipment_options = [
    deepClone(JSONB_CANONICAL_SOFTBOARD),
  ];

  const dryAfter = await dryRunOrApply(pg, { apply: false });
  assert.strictEqual(dryAfter.packs_changed, 0, 'post-apply jsonb re-read: zero changes');
  assert.strictEqual(dryAfter.private_changed, 0);
  const apply2 = await dryRunOrApply(pg, { apply: true });
  assert.strictEqual(apply2.packs_changed, 0, 'second apply after jsonb re-read: zero');
  assert.strictEqual(apply2.committed, true);

  console.log('  legacy rewrite then jsonb-stable second: OK');
}

async function main() {
  console.log('verify-reconcile-course-equipment-option-prices');
  selfCheck();
  testPureTransform();
  await testBadConfigBlocksGood();
  await testMidUpdateRollback();
  await testCleanApplyAndIdempotentSecond();
  await testJsonbKeyOrderIdempotentDryAndSecondRun();
  await testLegacyStillChangesThenStable();
  console.log('ALL GREEN — reconcile fail-closed contract holds (no real DB)');
}

main().catch((err) => {
  console.error('RED', err);
  process.exit(1);
});
