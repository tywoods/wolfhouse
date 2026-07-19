'use strict';

/**
 * FOUNDATION Slice 13C.3b — disposable-only rehearsal harness for immutable
 * migration 035_customer_message_templates.sql.
 *
 * Defaults DISABLED. Never writes schema_migration_ledger. Never claims
 * canonical-runner execution provenance. Rejects non-loopback / non-wh_mig_* DSNs.
 * Catalog preflight validates semantics before executing the byte-identical file.
 */

const fs = require('fs');
const path = require('path');
const {
  MIGRATIONS_DIR,
  assertSafeDatabaseTarget,
  prepareMigrationBody,
  sha256CanonicalLfV1File,
} = require('./migration-integrity');

const MIG_035 = '035_customer_message_templates.sql';
const MIG_035_ID = '035_customer_message_templates';
const TABLE = 'customer_message_templates';
const EXPECTED_SHA256 = '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565';

/** Live / Azure apply capability — permanently false in this slice. */
const REHEARSAL_LIVE_APPLY_ENABLED = false;

/** Must be set true by disposable prove scripts only. */
const DEFAULT_DISPOSABLE_REHEARSAL_ENABLED = false;

const EXPECTED_COLUMNS = Object.freeze([
  {
    name: 'id',
    udt: 'uuid',
    nullable: false,
    defaultNorm: 'gen_random_uuid()',
    generated: '',
    identity: '',
  },
  {
    name: 'client_id',
    udt: 'uuid',
    nullable: false,
    defaultNorm: null,
    generated: '',
    identity: '',
  },
  {
    name: 'title',
    udt: 'text',
    nullable: false,
    defaultNorm: null,
    generated: '',
    identity: '',
  },
  {
    name: 'body',
    udt: 'text',
    nullable: false,
    defaultNorm: null,
    generated: '',
    identity: '',
  },
  {
    name: 'channel',
    udt: 'text',
    nullable: false,
    defaultNorm: "'whatsapp'",
    generated: '',
    identity: '',
  },
  {
    name: 'tags',
    udt: 'jsonb',
    nullable: false,
    defaultNorm: "'[]'",
    generated: '',
    identity: '',
  },
  {
    name: 'active',
    udt: 'bool',
    nullable: false,
    defaultNorm: 'true',
    generated: '',
    identity: '',
  },
  {
    name: 'created_at',
    udt: 'timestamptz',
    nullable: false,
    defaultNorm: 'now()',
    generated: '',
    identity: '',
  },
  {
    name: 'updated_at',
    udt: 'timestamptz',
    nullable: false,
    defaultNorm: 'now()',
    generated: '',
    identity: '',
  },
]);

function normDefault(expr) {
  if (expr == null || expr === '') return null;
  return String(expr)
    .toLowerCase()
    .replace(/::[a-z_][a-z0-9_]*/gi, '')
    .replace(/\s+/g, '');
}

function migration035Path() {
  return path.join(MIGRATIONS_DIR, MIG_035);
}

function assertMigration035ByteIntegrity() {
  const live = sha256CanonicalLfV1File(migration035Path());
  if (live !== EXPECTED_SHA256) {
    throw Object.assign(
      new Error(`035 checksum drift: got ${live}, expected ${EXPECTED_SHA256}`),
      { code: 'migration_035_checksum_mismatch' },
    );
  }
  return live;
}

function assertDisposableConnection(connection) {
  const safety = assertSafeDatabaseTarget(connection);
  if (!safety.ok) {
    const err = Object.assign(
      new Error(`non-disposable DSN rejected: ${(safety.errors || []).map((e) => e.code).join(',')}`),
      { code: 'non_disposable_dsn', errors: safety.errors },
    );
    throw err;
  }
}

async function loadColumnCatalog(client) {
  const res = await client.query(
    `
    SELECT
      a.attname AS name,
      t.typname AS udt_name,
      NOT a.attnotnull AS is_nullable,
      pg_get_expr(d.adbin, d.adrelid) AS col_default,
      a.attgenerated::text AS attgenerated,
      a.attidentity::text AS attidentity
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.customer_message_templates'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attname
    `,
  );
  return res.rows;
}

async function loadPkFkIndexRls(client) {
  const pk = await client.query(
    `
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND rel.relname = $1
      AND c.contype = 'p'
    `,
    [TABLE],
  );
  const fk = await client.query(
    `
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND rel.relname = $1
      AND c.contype = 'f'
    ORDER BY c.conname
    `,
    [TABLE],
  );
  const idx = await client.query(
    `
    SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def
    FROM pg_index x
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = $1
    ORDER BY i.relname
    `,
    [TABLE],
  );
  const rls = await client.query(
    `
    SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1
    `,
    [TABLE],
  );
  const policies = await client.query(
    `
    SELECT pol.polname AS name
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1
    ORDER BY pol.polname
    `,
    [TABLE],
  );
  const triggers = await client.query(
    `
    SELECT t.tgname AS name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = $1
      AND NOT t.tgisinternal
    ORDER BY t.tgname
    `,
    [TABLE],
  );
  return {
    pk: pk.rows,
    fk: fk.rows,
    indexes: idx.rows,
    rls: rls.rows[0] || null,
    policies: policies.rows,
    triggers: triggers.rows,
  };
}

function assertColumnCompatible(row, expected) {
  if (row.udt_name !== expected.udt) {
    throw Object.assign(
      new Error(
        `035 preflight: column ${expected.name} incompatible type (udt=${row.udt_name}, expected ${expected.udt})`,
      ),
      { code: 'incompatible_column_type', column: expected.name },
    );
  }
  if (Boolean(row.is_nullable) !== Boolean(expected.nullable)) {
    throw Object.assign(
      new Error(
        `035 preflight: column ${expected.name} incompatible nullability (nullable=${row.is_nullable})`,
      ),
      { code: 'incompatible_column_nullability', column: expected.name },
    );
  }
  const gotDef = normDefault(row.col_default);
  const expDef = expected.defaultNorm == null ? null : normDefault(expected.defaultNorm);
  if (gotDef !== expDef) {
    throw Object.assign(
      new Error(
        `035 preflight: column ${expected.name} incompatible default (got=${gotDef}, expected=${expDef})`,
      ),
      { code: 'incompatible_column_default', column: expected.name },
    );
  }
  const gen = String(row.attgenerated || '');
  if (gen && gen !== '' && gen !== ' ') {
    throw Object.assign(
      new Error(`035 preflight: column ${expected.name} is a generated column`),
      { code: 'incompatible_column_generated', column: expected.name },
    );
  }
  const ident = String(row.attidentity || '');
  if (ident && ident !== '' && ident !== ' ') {
    throw Object.assign(
      new Error(`035 preflight: column ${expected.name} has identity`),
      { code: 'incompatible_column_identity', column: expected.name },
    );
  }
}

/**
 * Catalog semantic preflight when customer_message_templates already exists.
 * Absent table → ok (CREATE path). Exact compatible → ok (IF NOT EXISTS no-op).
 * Incompatible type/default/nullability/generated/PK/FK/index/RLS → fail closed.
 */
async function preflightCustomerMessageTemplatesCompat(client) {
  const exists = await client.query(`SELECT to_regclass('public.customer_message_templates') AS reg`);
  if (!exists.rows[0] || !exists.rows[0].reg) {
    const clients = await client.query(`SELECT to_regclass('public.clients') AS reg`);
    if (!clients.rows[0] || !clients.rows[0].reg) {
      throw Object.assign(
        new Error('035 preflight: clients table missing (FK parent required)'),
        { code: 'missing_clients_parent' },
      );
    }
    return { present: false, compatible: true, action: 'create' };
  }

  const cols = await loadColumnCatalog(client);
  const byName = new Map(cols.map((c) => [c.name, c]));
  for (const expected of EXPECTED_COLUMNS) {
    const row = byName.get(expected.name);
    if (!row) {
      throw Object.assign(
        new Error(`035 preflight: missing column ${expected.name} on existing table`),
        { code: 'incompatible_missing_column', column: expected.name },
      );
    }
    assertColumnCompatible(row, expected);
  }
  for (const row of cols) {
    if (!EXPECTED_COLUMNS.some((e) => e.name === row.name)) {
      throw Object.assign(
        new Error(`035 preflight: unexpected extra column ${row.name}`),
        { code: 'incompatible_extra_column', column: row.name },
      );
    }
  }

  const meta = await loadPkFkIndexRls(client);
  if (meta.pk.length !== 1 || meta.pk[0].conname !== 'customer_message_templates_pkey') {
    throw Object.assign(new Error('035 preflight: incompatible PRIMARY KEY'), {
      code: 'incompatible_pk',
    });
  }
  if (!/PRIMARY KEY \(id\)/i.test(String(meta.pk[0].def || ''))) {
    throw Object.assign(new Error('035 preflight: incompatible PRIMARY KEY definition'), {
      code: 'incompatible_pk',
    });
  }

  const fkClient = meta.fk.find((f) => f.conname === 'customer_message_templates_client_id_fkey');
  if (!fkClient) {
    throw Object.assign(new Error('035 preflight: missing client_id FOREIGN KEY'), {
      code: 'incompatible_fk',
    });
  }
  if (
    !/FOREIGN KEY \(client_id\) REFERENCES (public\.)?clients\(id\)/i.test(String(fkClient.def || ''))
    || !/ON DELETE CASCADE/i.test(String(fkClient.def || ''))
  ) {
    throw Object.assign(new Error('035 preflight: incompatible client_id FOREIGN KEY'), {
      code: 'incompatible_fk',
    });
  }

  const idxActive = meta.indexes.find((i) => i.name === 'idx_customer_message_templates_client_active');
  if (!idxActive) {
    throw Object.assign(new Error('035 preflight: missing idx_customer_message_templates_client_active'), {
      code: 'incompatible_index',
    });
  }
  const idxDef = String(idxActive.def || '').replace(/\s+/g, ' ');
  if (
    !/CREATE INDEX idx_customer_message_templates_client_active ON (public\.)?customer_message_templates USING btree \(client_id, active, updated_at DESC\)/i.test(
      idxDef,
    )
  ) {
    throw Object.assign(
      new Error(`035 preflight: incompatible index definition: ${idxDef}`),
      { code: 'incompatible_index' },
    );
  }

  if (!meta.rls || meta.rls.enabled !== false || meta.rls.forced !== false) {
    throw Object.assign(new Error('035 preflight: incompatible RLS enablement'), {
      code: 'incompatible_rls',
    });
  }
  if ((meta.policies || []).length > 0) {
    throw Object.assign(new Error('035 preflight: unexpected RLS policies on customer_message_templates'), {
      code: 'incompatible_rls_policy',
    });
  }
  if ((meta.triggers || []).length > 0) {
    throw Object.assign(
      new Error('035 preflight: unexpected triggers (035 owns none)'),
      { code: 'incompatible_trigger' },
    );
  }

  return { present: true, compatible: true, action: 'preserve_noop' };
}

/**
 * Apply immutable 035 SQL inside a harness-owned transaction after catalog preflight.
 * Does not insert into schema_migration_ledger.
 *
 * @param {import('pg').Client} client connected client
 * @param {object} opts
 * @param {object} opts.connection safety-checked connection info
 * @param {boolean} [opts.disposableRehearsalEnabled=false]
 */
async function rehearseMigration035Disposable(client, opts) {
  const options = opts || {};
  if (REHEARSAL_LIVE_APPLY_ENABLED) {
    throw Object.assign(new Error('live apply must remain disabled'), { code: 'live_apply_forbidden' });
  }
  if (!options.disposableRehearsalEnabled) {
    throw Object.assign(
      new Error('disposable 035 rehearsal harness is disabled (set disposableRehearsalEnabled for prove scripts only)'),
      { code: 'rehearsal_disabled' },
    );
  }
  assertDisposableConnection(options.connection);
  const sha = assertMigration035ByteIntegrity();

  const raw = fs.readFileSync(migration035Path(), 'utf8');
  const prepared = prepareMigrationBody(raw);
  if (!prepared.ok) {
    throw Object.assign(new Error(prepared.message || '035 prepare failed'), {
      code: prepared.code || 'txn_prepare_failed',
    });
  }

  await client.query('BEGIN');
  let preflight;
  try {
    preflight = await preflightCustomerMessageTemplatesCompat(client);
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

  return {
    ok: true,
    migrationId: MIG_035_ID,
    filename: MIG_035,
    sha256CanonicalLfV1: sha,
    preflight,
    claimsCanonicalRunnerProvenance: false,
    wroteSchemaMigrationLedger: false,
    liveApplyEnabled: REHEARSAL_LIVE_APPLY_ENABLED,
  };
}

/** Exact compatible CREATE for Path B pre-seed (mirrors 035 semantics; not a live dump). */
const COMPATIBLE_CMT_DDL = `
CREATE TABLE customer_message_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'whatsapp',
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_customer_message_templates_client_active
  ON customer_message_templates (client_id, active, updated_at DESC);
COMMENT ON TABLE customer_message_templates IS 'Staff Portal: saved WhatsApp message templates for Customers outreach (per tenant).';
`;

module.exports = {
  MIG_035,
  MIG_035_ID,
  TABLE,
  EXPECTED_SHA256,
  EXPECTED_COLUMNS,
  REHEARSAL_LIVE_APPLY_ENABLED,
  DEFAULT_DISPOSABLE_REHEARSAL_ENABLED,
  COMPATIBLE_CMT_DDL,
  migration035Path,
  assertMigration035ByteIntegrity,
  assertDisposableConnection,
  preflightCustomerMessageTemplatesCompat,
  rehearseMigration035Disposable,
  normDefault,
};
