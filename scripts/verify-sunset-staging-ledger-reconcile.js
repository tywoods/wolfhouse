'use strict';

const assert = require('assert');
const r = require('./lib/sunset-staging-ledger-reconcile');
const { CHECKSUM_MODE_CANONICAL_LF_V1, APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER } = require('./lib/migration-integrity');

function fakeClient(rows, catalogRows, failSql) {
  const calls = [];
  return {
    calls, rows,
    async query(sql, params) {
      calls.push(String(sql));
      if (failSql && String(sql).includes(failSql)) throw Object.assign(new Error('injected failure'), { code: 'injected_failure' });
      if (String(sql).startsWith('SELECT kind, name, detail')) return { rows: catalogRows };
      if (String(sql).startsWith('SELECT id, filename')) return { rows: rows.slice().sort((a, b) => a.apply_order - b.apply_order) };
      if (String(sql).startsWith('SELECT NOW()')) return { rows: [{ ledger_txn_ts: '2026-08-05T00:00:00Z' }] };
      if (String(sql).startsWith('INSERT INTO schema_migration_ledger')) {
        rows.push({ id: params[0], filename: params[1], checksum_sha256: params[2], apply_order: params[3],
          apply_kind: params[4], checksum_mode: params[5], evidence_ref: params[6], provenance_notes: params[7],
          applied_at: params[8], ledger_recorded_at: params[8] });
      }
      return { rows: [] };
    },
  };
}
function fixture() {
  const ctx = r.manifestContext();
  const base = ctx.forward.slice(0, 53).map((e) => ({
    id: e.id, filename: e.filename, checksum_sha256: e.sha256, apply_order: e.order,
    apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER, checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    evidence_ref: `fixture:${e.id}`, provenance_notes: 'fixture', applied_at: '2026-08-01T00:00:00Z', ledger_recorded_at: '2026-08-01T00:00:00Z',
  }));
  const catalog = [
    { kind: 'table', name: 'booking_refund_records', detail: 'x' },
    { kind: 'table', name: 'bookings', detail: 'hidden:boolean' },
    { kind: 'index', name: 'booking_refund_records_client_idempotency_uidx', detail: 'x' },
    { kind: 'index', name: 'booking_refund_records_booking_idx', detail: 'x' },
    { kind: 'index', name: 'booking_refund_records_client_location_idx', detail: 'x' },
    { kind: 'index', name: 'booking_refund_records_client_created_idx', detail: 'x' },
    { kind: 'trigger', name: 'booking_refund_records_no_update', detail: 'x' },
    { kind: 'trigger', name: 'booking_refund_records_no_delete', detail: 'x' },
    { kind: 'constraint', name: 'booking_refund_records_booking_client_fk', detail: 'x' },
    { kind: 'constraint', name: 'booking_refund_records_client_fk', detail: 'x' },
    { kind: 'index', name: 'bookings_hidden_true_idx', detail: 'x' },
  ];
  const c = fakeClient(base, catalog);
  return r.probeCatalog(c).then(({ fingerprint }) => r.sealEvidence({
    target: r.TARGET, manifestDigest: ctx.manifestDigest, catalogFingerprint: fingerprint, ledgerRows: base,
  })).then((evidence) => ({ ctx, base, catalog, evidence }));
}
function env(token) { return { [r.ENV_ENABLED]: '1', [r.ENV_TOKEN]: token }; }
function argv(mode) { return [mode, '--approve-sunset-ledger-reconcile', '--subscription', r.TARGET.subscriptionId, '--resource-group', r.TARGET.resourceGroup, '--postgres-server', r.TARGET.postgresServer, '--database', r.TARGET.database]; }

(async () => {
  const fx = await fixture();
  const dry = r.certify({ evidence: fx.evidence, context: fx.ctx });
  assert(dry.ok);
  assert.strictEqual(r.evaluateGates({ env: {}, argv: argv('--dry-run'), evidence: fx.evidence }).ok, false);
  assert.strictEqual(r.evaluateGates({ env: { [r.ENV_ENABLED]: '1', [r.ENV_EMAIL_OFF]: 'yes' }, argv: argv('--dry-run'), evidence: fx.evidence }).ok, false);
  assert.strictEqual(r.evaluateGates({ env: env(dry.approvalToken), argv: [...argv('--dry-run'), '--dsn=x'], evidence: fx.evidence }).ok, false);
  const badEvidence = { ...fx.evidence, ledgerRows: [] };
  assert.strictEqual(r.certify({ evidence: badEvidence, context: fx.ctx }).ok, false);
  assert.strictEqual((await r.executeReconcileMutation({ env: env(dry.approvalToken), argv: argv('--apply-sunset-ledger-reconcile'), evidence: fx.evidence })).code, 'db_client_required');

  const rows = fx.base.map((x) => ({ ...x }));
  const client = fakeClient(rows, fx.catalog);
  const applied = await r.executeReconcileMutation({ env: env(dry.approvalToken), argv: argv('--apply-sunset-ledger-reconcile'), evidence: fx.evidence, context: fx.ctx, client });
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(rows.length, 58);
  assert.strictEqual(rows.find((x) => x.id === r.IDS[0]).apply_kind, 'verified_structural_baseline');
  assert.strictEqual(rows.find((x) => x.id === r.IDS[4]).apply_kind, 'verified_structural_baseline');
  for (const id of r.IDS.slice(1, 4)) assert.strictEqual(rows.find((x) => x.id === id).apply_kind, APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER);
  assert(client.calls.includes('BEGIN') && client.calls.includes('COMMIT'));

  const rollbackRows = fx.base.map((x) => ({ ...x }));
  const failing = fakeClient(rollbackRows, fx.catalog, 'CREATE TABLE tenant_email_delegated_grants');
  const rollback = await r.executeReconcileMutation({ env: env(dry.approvalToken), argv: argv('--apply-sunset-ledger-reconcile'), evidence: fx.evidence, context: fx.ctx, client: failing });
  assert.strictEqual(rollback.ok, false);
  assert(failing.calls.includes('ROLLBACK'));
  console.log('verify-sunset-staging-ledger-reconcile: PASS');
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
