'use strict';

/**
 * FOUNDATION Slice 13C.3d — integrated disposable Phase C sequence orchestrator.
 *
 * Reviewed sequence (exact locked bytes): 040 → immutable 035 (disabled disposable
 * harness) → 041. Models multi-transaction checkpoints honestly (not all-three
 * atomic). Defaults DISABLED. Never writes schema_migration_ledger for the
 * Phase C sequence steps. Never claims canonical-runner provenance for 035/040/041
 * sequence application. Rejects non-loopback / non-wh_mig_* DSNs before connect.
 */

const fs = require('fs');
const path = require('path');
const {
  MIGRATIONS_DIR,
  assertSafeDatabaseTarget,
  prepareMigrationBody,
  sha256CanonicalLfV1File,
} = require('./migration-integrity');
const {
  rehearseMigration035Disposable,
  assertDisposableConnection,
  assertMigration035ByteIntegrity,
  EXPECTED_SHA256: MIG_035_SHA,
} = require('./rehearse-migration-035-disposable');

const MIG_040 = '040_tenant_services_saas_catalog_columns.sql';
const MIG_040_ID = '040_tenant_services_saas_catalog_columns';
const MIG_035 = '035_customer_message_templates.sql';
const MIG_035_ID = '035_customer_message_templates';
const MIG_041 = '041_notification_surfpack_convergence.sql';
const MIG_041_ID = '041_notification_surfpack_convergence';

const LOCKED_SHA = Object.freeze({
  '035': MIG_035_SHA,
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

/** Live / Azure apply capability — permanently false. */
const PHASE_C_LIVE_APPLY_ENABLED = false;

/** Must be set true by disposable prove scripts only. */
const DEFAULT_PHASE_C_INTEGRATED_ENABLED = false;

const PHASE_ORDER = Object.freeze(['040', '035', '041']);

const TENANT_SERVICES_COLUMN_KEYS = Object.freeze([
  'expected_only|columns|tenant_services.block_rooms_enabled',
  'expected_only|columns|tenant_services.blocked_room_codes',
  'expected_only|columns|tenant_services.room_block_booking_ids',
  'expected_only|columns|tenant_services.weekdays',
]);

/** Historical 13C.2 live_only labels for the same four column objects. */
const TENANT_SERVICES_COLUMN_KEYS_HISTORICAL_LIVE_ONLY = Object.freeze([
  'live_only|columns|tenant_services.block_rooms_enabled',
  'live_only|columns|tenant_services.blocked_room_codes',
  'live_only|columns|tenant_services.room_block_booking_ids',
  'live_only|columns|tenant_services.weekdays',
]);

const CMT_OWNED_KEYS = Object.freeze([
  'expected_only|acls|relation:customer_message_templates',
  'expected_only|columns|customer_message_templates.active',
  'expected_only|columns|customer_message_templates.body',
  'expected_only|columns|customer_message_templates.channel',
  'expected_only|columns|customer_message_templates.client_id',
  'expected_only|columns|customer_message_templates.created_at',
  'expected_only|columns|customer_message_templates.id',
  'expected_only|columns|customer_message_templates.tags',
  'expected_only|columns|customer_message_templates.title',
  'expected_only|columns|customer_message_templates.updated_at',
  'expected_only|constraints|customer_message_templates.customer_message_templates_client_id_fkey.FOREIGN KEY',
  'expected_only|constraints|customer_message_templates.customer_message_templates_pkey.PRIMARY KEY',
  'expected_only|indexes|customer_message_templates.customer_message_templates_pkey',
  'expected_only|indexes|customer_message_templates.idx_customer_message_templates_client_active',
  'expected_only|ownership|relation:customer_message_templates',
  'expected_only|rlsFlags|customer_message_templates',
  'expected_only|tables|customer_message_templates',
]);

const PHASE_C_SIX_KEYS = Object.freeze([
  'expected_only|constraints|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_client_created',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_conversation',
  'expected_only|indexes|client_notification_settings.idx_client_notification_settings_client',
  'expected_only|indexes|tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc',
  'expected_only|triggers|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at',
]);

const PHASE_D_REMAINING_KEYS = Object.freeze([
  'expected_only|constraints|tenant_services.tenant_services_date_window.CHECK',
  'expected_only|constraints|tenant_services.tenant_services_price_unit.CHECK',
]);

const PRESTATE_29_KEYS = Object.freeze(
  []
    .concat(TENANT_SERVICES_COLUMN_KEYS)
    .concat(CMT_OWNED_KEYS)
    .concat(PHASE_C_SIX_KEYS)
    .concat(PHASE_D_REMAINING_KEYS)
    .slice()
    .sort(),
);

const AFTER_040_KEYS = Object.freeze(
  []
    .concat(CMT_OWNED_KEYS)
    .concat(PHASE_C_SIX_KEYS)
    .concat(PHASE_D_REMAINING_KEYS)
    .slice()
    .sort(),
);

const AFTER_035_KEYS = Object.freeze(
  [].concat(PHASE_C_SIX_KEYS).concat(PHASE_D_REMAINING_KEYS).slice().sort(),
);

const AFTER_041_KEYS = Object.freeze(PHASE_D_REMAINING_KEYS.slice().sort());

const DROP_FOUR_COLUMNS_SQL = `
ALTER TABLE tenant_services DROP COLUMN IF EXISTS weekdays;
ALTER TABLE tenant_services DROP COLUMN IF EXISTS block_rooms_enabled;
ALTER TABLE tenant_services DROP COLUMN IF EXISTS blocked_room_codes;
ALTER TABLE tenant_services DROP COLUMN IF EXISTS room_block_booking_ids;
`;

const DROP_CMT_SQL = `DROP TABLE IF EXISTS customer_message_templates CASCADE;`;

const DROP_SIX_OBJECTS_SQL = `
DROP TRIGGER IF EXISTS tenant_surf_pack_rules_updated_at ON tenant_surf_pack_rules;
ALTER TABLE tenant_surf_pack_rules DROP CONSTRAINT IF EXISTS tenant_surf_pack_rules_updated_by_fkey;
DROP INDEX IF EXISTS public.idx_tenant_surf_pack_client_loc;
DROP INDEX IF EXISTS public.idx_client_notification_events_client_created;
DROP INDEX IF EXISTS public.idx_client_notification_events_conversation;
DROP INDEX IF EXISTS public.idx_client_notification_settings_client;
`;

const DROP_PHASE_D_CHECKS_SQL = `
ALTER TABLE tenant_services DROP CONSTRAINT IF EXISTS tenant_services_date_window;
ALTER TABLE tenant_services DROP CONSTRAINT IF EXISTS tenant_services_price_unit;
`;

function assertLockedMigrationHashes() {
  const got035 = assertMigration035ByteIntegrity();
  const got040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_040));
  const got041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_041));
  if (got035 !== LOCKED_SHA['035']) {
    throw Object.assign(new Error(`035 hash mismatch: ${got035}`), { code: 'wrong_base_hash_035' });
  }
  if (got040 !== LOCKED_SHA['040']) {
    throw Object.assign(new Error(`040 hash mismatch: ${got040}`), { code: 'wrong_base_hash_040' });
  }
  if (got041 !== LOCKED_SHA['041']) {
    throw Object.assign(new Error(`041 hash mismatch: ${got041}`), { code: 'wrong_base_hash_041' });
  }
  return { ...LOCKED_SHA };
}

function assertDisposableDsn(connection) {
  const safety = assertSafeDatabaseTarget(connection);
  if (!safety.ok) {
    throw Object.assign(
      new Error(`non-disposable DSN rejected: ${(safety.errors || []).map((e) => e.code).join(',')}`),
      { code: 'non_disposable_dsn', errors: safety.errors },
    );
  }
  assertDisposableConnection(connection);
}

async function applyMigrationSqlFile(client, filename) {
  const abs = path.join(MIGRATIONS_DIR, filename);
  const raw = fs.readFileSync(abs, 'utf8');
  const prepared = prepareMigrationBody(raw);
  if (!prepared.ok) throw new Error(`${filename}: ${prepared.message}`);
  await client.query('BEGIN');
  try {
    await client.query(prepared.body);
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Build disposable post-13C.2 drift prestate from a fresh 39-forward canonical DB:
 * omit exactly the 29 Phase-C/D substantive objects (4 columns, CMT cluster, six
 * notification/surf-pack objects, two Phase D CHECKs). Does not copy live rows.
 */
async function buildPost13c2DriftPrestate(client) {
  await client.query(DROP_FOUR_COLUMNS_SQL);
  await client.query(DROP_CMT_SQL);
  await client.query(DROP_SIX_OBJECTS_SQL);
  await client.query(DROP_PHASE_D_CHECKS_SQL);
}

function assertExactKeySet(actualKeys, expectedKeys, label) {
  const actual = (actualKeys || []).slice().sort();
  const expected = (expectedKeys || []).slice().sort();
  if (actual.length !== expected.length) {
    throw Object.assign(
      new Error(
        `${label}: key count ${actual.length} !== ${expected.length}; actual=${actual.join(', ')}`,
      ),
      { code: 'prestate_key_mismatch' },
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw Object.assign(
        new Error(`${label}: key mismatch at ${i}: got ${actual[i]} expected ${expected[i]}`),
        { code: 'prestate_key_mismatch' },
      );
    }
  }
}

function filterToUniverse(drifts, universe) {
  const set = new Set(universe);
  return drifts.map((d) => `${d.kind}|${d.section}|${d.key}`).filter((k) => set.has(k)).sort();
}

/**
 * Create an integrated Phase C run session. Checkpoints are in-memory only.
 * Each completed step is an independent transaction boundary.
 */
function createPhaseCIntegratedSession(options) {
  const opts = options || {};
  if (PHASE_C_LIVE_APPLY_ENABLED) {
    throw Object.assign(new Error('live apply must remain disabled'), { code: 'live_apply_forbidden' });
  }
  if (!opts.phaseCIntegratedEnabled) {
    throw Object.assign(
      new Error(
        'integrated Phase C orchestrator is disabled (set phaseCIntegratedEnabled for prove scripts only)',
      ),
      { code: 'phase_c_integrated_disabled' },
    );
  }
  assertDisposableDsn(opts.connection);
  assertLockedMigrationHashes();

  const completed = [];
  const checkpoints = [];

  function expectNext(phase) {
    const expected = PHASE_ORDER[completed.length];
    if (phase !== expected) {
      throw Object.assign(
        new Error(
          `Phase C sequence violation: expected next=${expected}, got=${phase}; completed=[${completed.join(',')}]`,
        ),
        { code: 'sequence_order_violation' },
      );
    }
  }

  function recordCheckpoint(phase, keys) {
    completed.push(phase);
    checkpoints.push({
      phase,
      completedAt: new Date().toISOString(),
      remainingKeyCount: keys.length,
      remainingKeys: keys.slice().sort(),
    });
  }

  async function apply040(client) {
    expectNext('040');
    await applyMigrationSqlFile(client, MIG_040);
    return {
      ok: true,
      phase: '040',
      migrationId: MIG_040_ID,
      wroteSchemaMigrationLedger: false,
      claimsCanonicalRunnerProvenance: false,
      pendingCheckpoint: true,
    };
  }

  async function apply035(client) {
    expectNext('035');
    const result = await rehearseMigration035Disposable(client, {
      connection: opts.connection,
      disposableRehearsalEnabled: true,
    });
    if (!result.ok) throw new Error('035 rehearsal failed');
    if (result.wroteSchemaMigrationLedger !== false) {
      throw new Error('035 must not write ledger');
    }
    if (result.claimsCanonicalRunnerProvenance !== false) {
      throw new Error('035 must not claim canonical-runner provenance');
    }
    return {
      ok: true,
      phase: '035',
      migrationId: MIG_035_ID,
      wroteSchemaMigrationLedger: false,
      claimsCanonicalRunnerProvenance: false,
      preflight: result.preflight,
      pendingCheckpoint: true,
    };
  }

  async function apply041(client) {
    expectNext('041');
    await applyMigrationSqlFile(client, MIG_041);
    return {
      ok: true,
      phase: '041',
      migrationId: MIG_041_ID,
      wroteSchemaMigrationLedger: false,
      claimsCanonicalRunnerProvenance: false,
      pendingCheckpoint: true,
    };
  }

  /**
   * Record checkpoint only after caller measures remaining keys from disposable DB.
   * Verifies measured keys match the locked post-phase set.
   */
  function commitCheckpoint(phase, measuredRemainingKeys) {
    expectNext(phase);
    const expectedKeys = phase === '040'
      ? AFTER_040_KEYS
      : phase === '035'
        ? AFTER_035_KEYS
        : AFTER_041_KEYS;
    assertExactKeySet(measuredRemainingKeys, expectedKeys, `after-${phase}`);
    recordCheckpoint(phase, measuredRemainingKeys);
    return checkpoints[checkpoints.length - 1];
  }

  async function run040(client, measuredRemainingKeysAfterApply) {
    await apply040(client);
    const cp = commitCheckpoint('040', measuredRemainingKeysAfterApply);
    return {
      ok: true,
      phase: '040',
      migrationId: MIG_040_ID,
      wroteSchemaMigrationLedger: false,
      claimsCanonicalRunnerProvenance: false,
      checkpoint: cp,
    };
  }

  async function run035(client, measuredRemainingKeysAfterApply) {
    const applied = await apply035(client);
    const cp = commitCheckpoint('035', measuredRemainingKeysAfterApply);
    return {
      ...applied,
      pendingCheckpoint: false,
      checkpoint: cp,
    };
  }

  async function run041(client, measuredRemainingKeysAfterApply) {
    await apply041(client);
    const cp = commitCheckpoint('041', measuredRemainingKeysAfterApply);
    return {
      ok: true,
      phase: '041',
      migrationId: MIG_041_ID,
      wroteSchemaMigrationLedger: false,
      claimsCanonicalRunnerProvenance: false,
      checkpoint: cp,
    };
  }

  /**
   * Apply next phase only (no checkpoint). Caller measures DB then commitCheckpoint.
   * On failure, no checkpoint is recorded (fail-stop).
   */
  async function applyNext(client, phase) {
    if (completed.includes(phase)) {
      throw Object.assign(
        new Error(`cannot apply already-completed phase ${phase}`),
        { code: 'sequence_duplicate' },
      );
    }
    if (phase === '040') return apply040(client);
    if (phase === '035') return apply035(client);
    if (phase === '041') return apply041(client);
    throw Object.assign(new Error(`unknown phase ${phase}`), { code: 'unknown_phase' });
  }

  /** Resume: apply phase, then caller must commitCheckpoint with measured keys. */
  async function resume(client, phase) {
    return applyNext(client, phase);
  }

  function snapshot() {
    return {
      completed: completed.slice(),
      checkpoints: checkpoints.map((c) => ({ ...c, remainingKeys: c.remainingKeys.slice() })),
      nextPhase: PHASE_ORDER[completed.length] || null,
      allComplete: completed.length === PHASE_ORDER.length,
      claimsAllThreeAtomicity: false,
      wroteSchemaMigrationLedger: false,
      claimsCanonicalRunnerProvenance: false,
      liveApplyEnabled: PHASE_C_LIVE_APPLY_ENABLED,
    };
  }

  return {
    apply040,
    apply035,
    apply041,
    applyNext,
    commitCheckpoint,
    resume,
    /** @deprecated prefer applyNext + commitCheckpoint with measured keys */
    run040,
    run035,
    run041,
    snapshot,
    PHASE_ORDER,
  };
}

module.exports = {
  PHASE_C_LIVE_APPLY_ENABLED,
  DEFAULT_PHASE_C_INTEGRATED_ENABLED,
  LOCKED_SHA,
  MIG_040,
  MIG_040_ID,
  MIG_035,
  MIG_035_ID,
  MIG_041,
  MIG_041_ID,
  PHASE_ORDER,
  TENANT_SERVICES_COLUMN_KEYS,
  TENANT_SERVICES_COLUMN_KEYS_HISTORICAL_LIVE_ONLY,
  CMT_OWNED_KEYS,
  PHASE_C_SIX_KEYS,
  PHASE_D_REMAINING_KEYS,
  PRESTATE_29_KEYS,
  AFTER_040_KEYS,
  AFTER_035_KEYS,
  AFTER_041_KEYS,
  DROP_FOUR_COLUMNS_SQL,
  DROP_CMT_SQL,
  DROP_SIX_OBJECTS_SQL,
  DROP_PHASE_D_CHECKS_SQL,
  assertLockedMigrationHashes,
  assertDisposableDsn,
  applyMigrationSqlFile,
  buildPost13c2DriftPrestate,
  assertExactKeySet,
  filterToUniverse,
  createPhaseCIntegratedSession,
};
