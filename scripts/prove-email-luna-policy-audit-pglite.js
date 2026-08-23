'use strict';

/**
 * Prove migration 085 tenant_email_luna_policy_audit + persist semantics.
 *
 * When PGlite is available:
 *   - minimal parent shell + 085 up
 *   - eligible and handoff persist
 *   - replay no-op / operation and issuance conflicts
 *   - sensitive columns absent
 *   - append-only protect
 *   - down fail-closed with rows; clean restore without
 *
 * When PGlite is unavailable: static migration contract only.
 *
 * No Azure / live product DB / deploy / send path.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
const { issueAndDecideEmailLunaDraftPolicy, EMAIL_LUNA_DRAFT_POLICY_VERSION } = require('./lib/email-luna-draft-policy');
const {
  decideEmailLunaAutonomousEligibility,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
} = require('./lib/email-luna-autonomous-eligibility-policy');
const {
  createEmailLunaPolicyAuditStore,
  EMAIL_LUNA_POLICY_AUDIT_SCHEMA_085,
} = require('./lib/email-luna-policy-audit-store');

const ROOT = path.resolve(__dirname, '..');
const UP_PATH = path.join(ROOT, 'database/migrations/085_tenant_email_luna_policy_audit.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/085_tenant_email_luna_policy_audit_down.sql');
const UP = fs.readFileSync(UP_PATH, 'utf8');
const DOWN = fs.readFileSync(DOWN_PATH, 'utf8');

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  conversation: '33333333-3333-4333-8333-333333333333',
  endpoint: '44444444-4444-4444-8444-444444444444',
  inbound: '55555555-5555-4555-8555-555555555555',
  operation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOp: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const SAFE_FACT_REFS = Object.freeze(['catalog', 'availability', 'policy', 'booking', 'payment']);

function tryLoadPglite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (_) {
    return null;
  }
}

function shellSql() {
  return `
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id)
    );
    CREATE TABLE tenant_locations (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id),
      location_id text NOT NULL,
      display_name text NOT NULL DEFAULT 'loc',
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE tenant_channel_endpoints (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      location_id text NOT NULL,
      channel text NOT NULL DEFAULT 'email',
      provider text NOT NULL DEFAULT 'microsoft_graph',
      public_address text NOT NULL DEFAULT 'a@b.co',
      secret_ref text,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO clients VALUES ('${ids.client}');
    INSERT INTO conversations (id, client_id) VALUES ('${ids.conversation}', '${ids.client}');
    INSERT INTO tenant_locations (id, client_id, location_id)
      VALUES ('${ids.location}', '${ids.client}', 'sunset-somo');
    INSERT INTO tenant_channel_endpoints (id, client_id, location_id)
      VALUES ('${ids.endpoint}', '${ids.client}', 'sunset-somo');
  `;
}

function orderedFactRefSubsets() {
  const out = [];
  const n = SAFE_FACT_REFS.length;
  function choose(k, start, acc) {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let index = start; index < n; index += 1) {
      acc.push(SAFE_FACT_REFS[index]);
      choose(k, index + 1, acc);
      acc.pop();
    }
  }
  for (let k = 0; k <= n; k += 1) choose(k, 0, []);
  return out;
}

function arrayLiteral(elements) {
  if (elements === null) return 'NULL';
  const inner = elements.map((value) => (value === null ? 'NULL' : `'${value}'`)).join(', ');
  return `ARRAY[${inner}]::text[]`;
}

function closedFactRefsInList() {
  return orderedFactRefSubsets()
    .map((subset) => `      ${arrayLiteral(subset)}`)
    .join(',\n');
}

function factRefsInListBlock() {
  return `AND fact_refs IN (\n${closedFactRefsInList()}\n    )`;
}

function occurrences(source, block) {
  return source.split(block).length - 1;
}

function replaceUnique(source, block, replacement, label) {
  assert.equal(occurrences(source, block), 1, `${label}: pinned source block must occur exactly once`);
  const mutated = source.replace(block, replacement);
  assert.notEqual(mutated, source, `${label}: mutation must apply`);
  return mutated;
}

function assertStaticContract() {
  assert.match(UP, /CREATE TABLE tenant_email_luna_policy_audit/);
  assert.match(UP, /UNIQUE \(issuance_id\)/);
  assert.match(UP, /REFERENCES tenant_locations \(client_id, id, location_id\)/);
  assert.match(UP, /REFERENCES tenant_channel_endpoints \(client_id, id, location_id\)/);
  assert.match(UP, /REFERENCES conversations \(client_id, id\)/);
  assert.match(UP, /email-luna-draft-policy\.v1/);
  assert.match(UP, /email-luna-autonomous-eligibility-policy\.v1/);
  assert.match(UP, /DEFAULT NOW\(\)/);
  assert.match(UP, /fact_refs TEXT\[\] NOT NULL/);
  assert.match(UP, /CONSTRAINT tenant_email_luna_policy_audit_fact_refs_bounds CHECK/);
  assert.match(UP, /fact_refs IS NOT NULL/);
  assert.match(UP, /array_position\(fact_refs, NULL\) IS NULL/);
  assert.match(UP, /cardinality\(fact_refs\) BETWEEN 0 AND 5/);
  const subsets = orderedFactRefSubsets();
  assert.equal(subsets.length, 32);
  assert.deepEqual(subsets[0], []);
  assert.deepEqual(subsets[subsets.length - 1], SAFE_FACT_REFS.slice());
  assert.equal(occurrences(UP, factRefsInListBlock()), 1);
  for (const subset of subsets) {
    const literal = arrayLiteral(subset);
    assert.equal(UP.includes(literal), true, `closed representation missing ${literal}`);
  }
  assert.equal(/jsonb/i.test(UP), false);
  assert.equal(/\bbody_text\b|\bmessage_text\b|\bdraft_text\b|\bpayment_url\b/.test(UP), false);
  assert.equal(/CREATE TABLE tenant_email_outbound_send_journal/.test(UP), false);
  assert.equal(/REFERENCES tenant_email_outbound_send_journal/.test(UP), false);
  assert.equal(/INSERT INTO tenant_email_luna_policy_audit/.test(UP), false);
  assert.match(UP, /append-only mutation refused/);
  assert.match(DOWN, /085_down_refused/);
  assert.match(DOWN, /DROP TABLE IF EXISTS tenant_email_luna_policy_audit/);
  console.log('ok - static 085 luna policy audit contract');
}

function createPgliteExclusiveLoaner(db) {
  async function withTransactionClient(work) {
    await db.query('BEGIN');
    try {
      const client = {
        async query(text, params) {
          return db.query(text, params);
        },
      };
      const result = await work(client);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw error;
    }
  }
  return { withTransactionClient };
}

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const nested = frozen(value[key]);
      if (!Object.isFrozen(value)) value[key] = nested;
    }
    return Object.freeze(value);
  }
  return value;
}

function catalogTriplet() {
  const envelope = createEmailLunaDraftEnvelope({
    authority: {
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      conversation_id: ids.conversation,
      endpoint_id: ids.endpoint,
      inbound_message_id: ids.inbound,
    },
    untrusted_content: {
      subject: 'Lesson question',
      body_text: 'How much is a surf lesson?',
      quoted_history: '',
      from_display_name: 'Elena',
      from_address: 'elena@example.test',
    },
  });
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope,
    evidence: frozen({
      client_id: ids.client,
      location_id: ids.location,
      conversation_id: ids.conversation,
      endpoint_id: ids.endpoint,
      language: 'en',
      identity: 'matched',
      intent: 'catalog_question',
      intent_support: 'supported',
      requested_location_id: ids.location,
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
      required_facts: ['catalog'],
      grounded_results: {
        catalog: Object.assign(Object.create(null), {
          fact: 'catalog',
          status: 'found',
          client_id: ids.client,
          location_id: ids.location,
          item: 'lesson',
          label: 'Surf lesson',
          currency: 'EUR',
          amount_cents: 4500,
          active: true,
        }),
      },
    }),
  });
  return { envelope, evidence: issued.evidence, decision: issued.decision };
}

function seqId(kind, n) {
  const hex = String(n).padStart(12, '0');
  if (kind === 'operation') return `cccccccc-cccc-4ccc-8ccc-${hex}`;
  return `dddddddd-dddd-4ddd-8ddd-${hex}`;
}

function insertFactRefsSql(operationId, issuanceId, factRefsSql) {
  return `
    INSERT INTO tenant_email_luna_policy_audit (
      operation_id, issuance_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, policy_version, eligibility_policy_version,
      canonical_status, canonical_reason, eligibility_status, eligibility_reason, fact_refs
    ) VALUES (
      '${operationId}'::uuid, '${issuanceId}'::uuid,
      '${ids.client}'::uuid, '${ids.location}'::uuid, 'sunset-somo',
      '${ids.endpoint}'::uuid, '${ids.conversation}'::uuid,
      'email-luna-draft-policy.v1',
      'email-luna-autonomous-eligibility-policy.v1',
      'draft_ready', NULL, 'eligible', NULL,
      ${factRefsSql}
    )`;
}

function constraintViolation(err) {
  const msg = String(err && err.message || err);
  return /check|violat|null|not-null|not null|constraint/i.test(msg);
}

async function proveFactRefsConstraint(PGlite) {
  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(UP);
  let n = 0;
  async function insertLiteral(factRefsSql) {
    n += 1;
    await db.exec(insertFactRefsSql(seqId('operation', n), seqId('issuance', n), factRefsSql));
  }
  async function expectReject(factRefsSql, label) {
    let failed = false;
    try {
      await insertLiteral(factRefsSql);
    } catch (err) {
      failed = true;
      assert.ok(constraintViolation(err), `${label}: unexpected error ${String(err && err.message || err)}`);
    }
    assert.equal(failed, true, `${label}: expected rejection of ${factRefsSql}`);
  }

  await expectReject("ARRAY['payment','catalog','catalog']::text[]", 'duplicate unordered tuple');
  await expectReject("ARRAY['catalog','catalog']::text[]", 'duplicate singleton');
  await expectReject("ARRAY['payment','catalog']::text[]", 'reverse permutation');
  await expectReject("ARRAY['booking','availability']::text[]", 'noncanonical permutation');
  await expectReject("ARRAY['payment','policy','catalog']::text[]", 'shuffled triple');
  await expectReject('ARRAY[NULL]::text[]', 'null element');
  await expectReject("ARRAY['catalog', NULL]::text[]", 'mixed null element');
  await expectReject("ARRAY[NULL, 'payment']::text[]", 'leading null element');
  await expectReject("ARRAY['unknown']::text[]", 'unknown fact');
  await expectReject("ARRAY['Catalog']::text[]", 'case-mismatched fact');
  await expectReject(
    "ARRAY['catalog','availability','policy','booking','payment','catalog']::text[]",
    'cardinality greater than 5',
  );
  await expectReject('NULL', 'null array');
  console.log('ok - pglite 085 fact_refs hostile uniqueness/order/null rejections');

  const subsets = orderedFactRefSubsets();
  assert.equal(subsets.length, 32);
  for (const subset of subsets) {
    await insertLiteral(arrayLiteral(subset));
  }
  console.log('ok - pglite 085 fact_refs accepts every canonical ordered subset');

  const MEMBERSHIP_ONLY = `AND fact_refs <@ ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[]`;
  const UNIQUENESS_WITHOUT_ORDER = `AND cardinality(fact_refs) = (
      (CASE WHEN 'catalog' = ANY(fact_refs) THEN 1 ELSE 0 END)
      + (CASE WHEN 'availability' = ANY(fact_refs) THEN 1 ELSE 0 END)
      + (CASE WHEN 'policy' = ANY(fact_refs) THEN 1 ELSE 0 END)
      + (CASE WHEN 'booking' = ANY(fact_refs) THEN 1 ELSE 0 END)
      + (CASE WHEN 'payment' = ANY(fact_refs) THEN 1 ELSE 0 END)
    )
    AND fact_refs <@ ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[]`;
  const NULL_DEFENSE = '    AND array_position(fact_refs, NULL) IS NULL\n';
  const THREE_VALUED_ORDER = `AND (
      cardinality(fact_refs) = 0
      OR (
        array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[1]) IS NOT NULL
        AND (cardinality(fact_refs) < 2 OR array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[2]) > array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[1]))
        AND (cardinality(fact_refs) < 3 OR array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[3]) > array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[2]))
        AND (cardinality(fact_refs) < 4 OR array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[4]) > array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[3]))
        AND (cardinality(fact_refs) < 5 OR array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[5]) > array_position(ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[], fact_refs[4]))
      )
    )`;

  async function expectMutationAccepted(label, mutantSql, factRefsSql) {
    const mutant = new PGlite();
    await mutant.exec(shellSql());
    await mutant.exec(mutantSql);
    let accepted = false;
    try {
      await mutant.exec(insertFactRefsSql(seqId('operation', 1), seqId('issuance', 1), factRefsSql));
      accepted = true;
    } catch (err) {
      assert.notEqual(err && err.code, 'ERR_ASSERTION', `${label}: mutation helper must not throw assertion`);
    }
    assert.equal(accepted, true, `${label}: mutation must demonstrate the bypass so the pin is live`);
  }

  await expectMutationAccepted(
    'fact-refs-uniqueness',
    replaceUnique(UP, factRefsInListBlock(), MEMBERSHIP_ONLY, 'fact-refs-uniqueness'),
    "ARRAY['payment','catalog','catalog']::text[]",
  );
  await expectMutationAccepted(
    'fact-refs-order',
    replaceUnique(UP, factRefsInListBlock(), UNIQUENESS_WITHOUT_ORDER, 'fact-refs-order'),
    "ARRAY['payment','catalog']::text[]",
  );
  const withoutNull = replaceUnique(UP, NULL_DEFENSE, '', 'fact-refs-null');
  await expectMutationAccepted(
    'fact-refs-null',
    replaceUnique(withoutNull, factRefsInListBlock(), THREE_VALUED_ORDER, 'fact-refs-null-order'),
    "ARRAY['catalog', NULL]::text[]",
  );
  console.log('ok - pglite 085 fact_refs mutation isolation kills uniqueness/order/null bypasses');
}

async function provePglite(PGlite) {
  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(UP);
  const columns = await db.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'tenant_email_luna_policy_audit'
     ORDER BY ordinal_position
  `);
  const names = columns.rows.map((row) => row.column_name);
  assert.deepEqual(names, [
    'operation_id', 'issuance_id', 'client_id', 'location_id', 'location_key',
    'endpoint_id', 'conversation_id', 'policy_version', 'eligibility_policy_version',
    'canonical_status', 'canonical_reason', 'eligibility_status', 'eligibility_reason',
    'fact_refs', 'created_at',
  ]);
  assert.equal(names.includes('body_text'), false);
  assert.equal(names.includes('subject'), false);
  const store = createEmailLunaPolicyAuditStore({
    ...createPgliteExclusiveLoaner(db),
    schemaVersion: EMAIL_LUNA_POLICY_AUDIT_SCHEMA_085,
  });
  const triplet = catalogTriplet();
  const firstInput = {
    operation_id: ids.operation,
    envelope: triplet.envelope,
    evidence: triplet.evidence,
    decision: triplet.decision,
    eligibility: decideEmailLunaAutonomousEligibility(triplet),
  };
  const first = await store.persistPolicyAudit(firstInput);
  assert.equal(first.status, 'committed');
  assert.equal(first.record.policy_version, EMAIL_LUNA_DRAFT_POLICY_VERSION);
  assert.equal(first.record.eligibility_policy_version, EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION);
  assert.deepEqual(first.record.fact_refs, ['catalog']);
  const replay = await store.persistPolicyAudit(firstInput);
  assert.equal(replay.status, 'replayed');
  const other = catalogTriplet();
  const conflict = await store.persistPolicyAudit({
    operation_id: ids.operation,
    envelope: other.envelope,
    evidence: other.evidence,
    decision: other.decision,
    eligibility: decideEmailLunaAutonomousEligibility(other),
  });
  assert.equal(conflict.status, 'conflict');
  const issuanceConflict = await store.persistPolicyAudit({
    ...firstInput,
    operation_id: ids.otherOp,
  });
  assert.equal(issuanceConflict.status, 'conflict');
  const count = await db.query('SELECT COUNT(*)::int AS n FROM tenant_email_luna_policy_audit');
  assert.equal(count.rows[0].n, 1);
  await assert.rejects(async () => {
    await db.query('UPDATE tenant_email_luna_policy_audit SET location_key = $1', ['sunset-other']);
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore idle rollback */ }
  await assert.rejects(async () => {
    await db.exec(DOWN);
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* session may already be idle */ }
  await db.query('DROP TRIGGER IF EXISTS tenant_email_luna_policy_audit_protect_delete ON tenant_email_luna_policy_audit');
  await db.query('DELETE FROM tenant_email_luna_policy_audit');
  await db.exec(DOWN);
  const gone = await db.query(`
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'tenant_email_luna_policy_audit'
  `);
  assert.equal(gone.rows.length, 0);
  console.log('ok - pglite 085 persist/idempotency/conflict/append-only/down');
}

assertStaticContract();
const PGlite = tryLoadPglite();
if (!PGlite) {
  console.log('ok - pglite unavailable; static 085 contract only');
} else {
  Promise.resolve()
    .then(() => provePglite(PGlite))
    .then(() => proveFactRefsConstraint(PGlite))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
