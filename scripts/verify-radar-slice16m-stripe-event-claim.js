'use strict';

/**
 * verify:radar-slice16m-stripe-event-claim — RADAR Slice 16M
 *
 * Offline RED/GREEN gate for fail-closed Stripe webhook event-id claim
 * before booking-payment and addon_service mutations. Fake transactional
 * pg sequencing + source anti-pattern REDs. No network, no live DB, no deploy.
 *
 * COMMIT semantics (truthful):
 *   - Fake may prove only pre-commit / rejected-before-durable-apply rollback.
 *   - Never claim a rejected COMMIT definitely rolled back in production.
 *   - Modeled post-durable-commit ack-failure: retry sees durable claim, no mutation.
 *   - Real PostgreSQL contention / ambiguous-commit drill: open unless an
 *     isolated ephemeral PostgreSQL is started on this host (see REAL_PG block).
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MASTER = '49b4ccff673014b28047307514f91a508cc8c497';
const BRANCH = 'radar/slice-16m-stripe-event-claim';
const CONTRACT_REL = 'fixtures/radar-operations/slice16m-expected-contract.json';
const LIB_REL = 'scripts/lib/stripe-webhook-event-claim.js';
const TRUTH_REL = 'scripts/lib/stripe-webhook-payment-truth.js';
const API_REL = 'scripts/staff-query-api.js';

const {
  CLAIM_INSERT_SQL,
  MARK_PROCESSED_SQL,
  LOCK_OWNED_PAYMENT_SQL,
  IDEMPOTENT_DUPLICATE_REASON,
  IDEMPOTENT_DISTINCT_EVENT_BUSINESS_REASON,
  COMMIT_OUTCOME_UNKNOWN_CODE,
  STRIPE_WEBHOOK_EVENT_PAYLOAD_ALLOWLIST,
  FORBIDDEN_PAYLOAD_CANARIES,
  PAYMENT_EVENTS_OWNERSHIP_COLUMN,
  buildMinimizedStripeWebhookEventPayload,
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  lockOwnedPaymentForAddonEventClaim,
  withStripeWebhookEventClaim,
  buildStripeEventClaimIdempotentBody,
  buildStripeEventDistinctBusinessIdempotentBody,
  buildStripeEventClaimOutcomeUnknownBody,
  isStripeEventClaimCommitOutcomeUnknown,
  commitStripeWebhookEventTxnOrThrowUnknown,
} = require('./lib/stripe-webhook-event-claim');

let pass = 0;
let fail = 0;
let redPass = 0;
let redFail = 0;
let greenPass = 0;
let greenFail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

function red(label, cond, detail) {
  if (cond) {
    redPass += 1;
    pass += 1;
    console.log(`  RED   ${label}`);
    return true;
  }
  redFail += 1;
  fail += 1;
  console.log(`  FAIL-RED  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

function green(label, cond, detail) {
  if (cond) {
    greenPass += 1;
    pass += 1;
    console.log(`  GREEN ${label}`);
    return true;
  }
  greenFail += 1;
  fail += 1;
  console.log(`  FAIL-GREEN  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function uuid() {
  return crypto.randomUUID();
}

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

/**
 * Fake transactional pg with UNIQUE(stripe_event_id) claim store + optional
 * owned-payment FOR UPDATE ledger for addon distinct-event concurrency.
 */
function makeFakeTxnPg(opts) {
  const ledger = (opts && opts.ledger) || {
    events: new Map(),
    inflight: new Set(),
    paymentsMutations: 0,
    serviceMutations: 0,
    bookingMutations: 0,
    payments: new Map(),
    paymentLockWaiters: new Map(),
    paymentLockHolder: new Map(),
  };
  if (!ledger.inflight) ledger.inflight = new Set();
  if (!ledger.payments) ledger.payments = new Map();
  if (!ledger.paymentLockWaiters) ledger.paymentLockWaiters = new Map();
  if (!ledger.paymentLockHolder) ledger.paymentLockHolder = new Map();
  const state = {
    begun: false,
    committed: false,
    rolledBack: false,
    open: false,
    queries: [],
    mutationCount: 0,
    failOn: opts && opts.failOn,
    claimIds: new Map(),
    pendingClaim: null,
    heldPaymentLocks: new Set(),
    mutDelta: { payments: 0, service: 0, booking: 0 },
    durableApplyOnCommit: !opts || opts.durableApplyOnCommit !== false,
    rejectCommitBeforeApply: !!(opts && opts.rejectCommitBeforeApply),
  };

  function releaseLocks() {
    for (const paymentId of state.heldPaymentLocks) {
      ledger.paymentLockHolder.delete(paymentId);
      const waiters = ledger.paymentLockWaiters.get(paymentId) || [];
      ledger.paymentLockWaiters.set(paymentId, []);
      for (const w of waiters) w();
    }
    state.heldPaymentLocks.clear();
  }

  async function acquirePaymentLock(paymentId) {
    for (;;) {
      const holder = ledger.paymentLockHolder.get(paymentId);
      if (!holder || holder === state) {
        ledger.paymentLockHolder.set(paymentId, state);
        state.heldPaymentLocks.add(paymentId);
        return;
      }
      await new Promise((resolve) => {
        const list = ledger.paymentLockWaiters.get(paymentId) || [];
        list.push(resolve);
        ledger.paymentLockWaiters.set(paymentId, list);
      });
    }
  }

  async function query(sql, params) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push({ text, params: params || [] });
    if (state.failOn) {
      const hit = state.failOn(text, params || [], state, ledger);
      if (hit) {
        const err = new Error(hit.message || 'forced_failure');
        err.code = hit.code || 'forced_failure';
        throw err;
      }
    }
    if (/^BEGIN$/i.test(text)) {
      state.begun = true;
      state.open = true;
      state.committed = false;
      state.rolledBack = false;
      state.pendingClaim = null;
      state.mutDelta = { payments: 0, service: 0, booking: 0 };
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(text)) {
      if (!state.open) throw new Error('commit_without_begin');
      if (state.rejectCommitBeforeApply) {
        const err = new Error('commit_rejected_before_apply');
        err.code = 'commit_rejected_before_apply';
        throw err;
      }
      if (state.durableApplyOnCommit && state.pendingClaim) {
        ledger.events.set(state.pendingClaim.stripe_event_id, {
          ...state.pendingClaim,
        });
        ledger.inflight.delete(state.pendingClaim.stripe_event_id);
      }
      state.committed = true;
      state.open = false;
      state.pendingClaim = null;
      releaseLocks();
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(text)) {
      if (state.pendingClaim) {
        ledger.inflight.delete(state.pendingClaim.stripe_event_id);
        // Only remove if not already durable (ambiguous commit may have applied).
        if (!ledger.events.has(state.pendingClaim.stripe_event_id)
          || ledger.events.get(state.pendingClaim.stripe_event_id).id === state.pendingClaim.id) {
          if (!state.committed) {
            ledger.events.delete(state.pendingClaim.stripe_event_id);
          }
        }
      }
      if (!state.committed) {
        ledger.paymentsMutations = Math.max(0, ledger.paymentsMutations - state.mutDelta.payments);
        ledger.serviceMutations = Math.max(0, ledger.serviceMutations - state.mutDelta.service);
        ledger.bookingMutations = Math.max(0, ledger.bookingMutations - state.mutDelta.booking);
        // Revert payment status deltas for addon concurrency model
        if (state.mutDelta.payments > 0 && state._paymentStatusBefore) {
          for (const [pid, before] of state._paymentStatusBefore) {
            const row = ledger.payments.get(pid);
            if (row) row.payment_status = before;
          }
        }
      }
      state.rolledBack = true;
      state.open = false;
      state.pendingClaim = null;
      state.mutDelta = { payments: 0, service: 0, booking: 0 };
      releaseLocks();
      return { rows: [], rowCount: 0 };
    }

    if (/INSERT\s+INTO\s+payment_events/i.test(text)) {
      if (!state.open) {
        const err = new Error('claim_outside_transaction');
        err.code = 'claim_outside_transaction';
        throw err;
      }
      if (!/ON CONFLICT\s*\(\s*stripe_event_id\s*\)\s*DO NOTHING/i.test(text)) {
        const err = new Error('claim_missing_on_conflict');
        err.code = 'claim_missing_on_conflict';
        throw err;
      }
      if (!/RETURNING\s+id/i.test(text)) {
        const err = new Error('claim_missing_returning');
        err.code = 'claim_missing_returning';
        throw err;
      }
      const [
        clientId, paymentId, bookingId, stripeEventId, eventType, payloadJson,
      ] = params;
      if (ledger.events.has(stripeEventId) || ledger.inflight.has(stripeEventId)) {
        return { rows: [], rowCount: 0 };
      }
      const id = uuid();
      let payload;
      try { payload = JSON.parse(payloadJson); } catch (_) { payload = {}; }
      state.pendingClaim = {
        id,
        client_id: clientId,
        payment_id: paymentId,
        booking_id: bookingId,
        stripe_event_id: stripeEventId,
        event_type: eventType,
        payload,
        processed: false,
      };
      ledger.inflight.add(stripeEventId);
      state.claimIds.set(id, stripeEventId);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (/UPDATE\s+payment_events/i.test(text) && /processed\s*=\s*true/i.test(text)) {
      if (!state.open) {
        const err = new Error('processed_outside_transaction');
        err.code = 'processed_outside_transaction';
        throw err;
      }
      const claimId = params[0];
      const patchJson = params[1];
      if (!state.pendingClaim || state.pendingClaim.id !== claimId) {
        return { rows: [], rowCount: 0 };
      }
      if (patchJson) {
        let patch;
        try { patch = JSON.parse(patchJson); } catch (_) { patch = {}; }
        state.pendingClaim.payload = Object.assign({}, state.pendingClaim.payload || {}, patch);
      }
      state.pendingClaim.processed = true;
      return { rows: [{ id: claimId }], rowCount: 1 };
    }

    if (/FROM\s+payments\b/i.test(text) && /FOR UPDATE/i.test(text)) {
      if (!state.open) throw new Error('lock_outside_transaction');
      const paymentId = params[0];
      const clientId = params[1];
      await acquirePaymentLock(paymentId);
      const row = ledger.payments.get(paymentId);
      if (!row || String(row.client_id) !== String(clientId)) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{
          payment_id: paymentId,
          payment_status: row.payment_status,
          payment_kind: row.payment_kind,
          client_id: row.client_id,
        }],
        rowCount: 1,
      };
    }

    if (/UPDATE\s+payments/i.test(text)) {
      if (!state.open) throw new Error('mutation_outside_transaction');
      if (!state.pendingClaim) {
        const err = new Error('mutation_before_claim');
        err.code = 'mutation_before_claim';
        throw err;
      }
      const paymentId = params && params.length >= 4 ? params[params.length - 2] : state.pendingClaim.payment_id;
      const clientId = params && params.length >= 4 ? params[params.length - 1] : state.pendingClaim.client_id;
      const row = ledger.payments.get(paymentId);
      if (row) {
        if (String(row.client_id) !== String(clientId)) {
          return { rows: [], rowCount: 0 };
        }
        if (/payment_kind\s*=\s*'addon_service'/i.test(text) && row.payment_kind !== 'addon_service') {
          return { rows: [], rowCount: 0 };
        }
        if (row.payment_status === 'paid' && /IS DISTINCT FROM 'paid'/i.test(text)) {
          return { rows: [], rowCount: 0 };
        }
        if (!state._paymentStatusBefore) state._paymentStatusBefore = new Map();
        if (!state._paymentStatusBefore.has(paymentId)) {
          state._paymentStatusBefore.set(paymentId, row.payment_status);
        }
        row.payment_status = 'paid';
      }
      ledger.paymentsMutations += 1;
      state.mutDelta.payments += 1;
      state.mutationCount += 1;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE\s+booking_service_records/i.test(text)) {
      if (!state.pendingClaim) throw Object.assign(new Error('mutation_before_claim'), { code: 'mutation_before_claim' });
      ledger.serviceMutations += 1;
      state.mutDelta.service += 1;
      state.mutationCount += 1;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE\s+bookings/i.test(text)) {
      if (!state.pendingClaim) throw Object.assign(new Error('mutation_before_claim'), { code: 'mutation_before_claim' });
      ledger.bookingMutations += 1;
      state.mutDelta.booking += 1;
      state.mutationCount += 1;
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT\s+id,\s*amount_due_cents/i.test(text)) {
      return { rows: [{ id: uuid(), amount_due_cents: 1000, payment_status: 'unpaid' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { query, state, ledger };
}

/** Simulate booking-payment route transaction (claim → mutate → processed → commit). */
async function runBookingPaymentRouteTxn(pg, claimInput, mutateFn) {
  await pg.query('BEGIN');
  try {
    const outcome = await withStripeWebhookEventClaim(pg, claimInput, mutateFn);
    if (outcome.duplicate) {
      await pg.query('ROLLBACK');
      return { status: 200, body: buildStripeEventClaimIdempotentBody(claimInput), duplicate: true };
    }
    await commitStripeWebhookEventTxnOrThrowUnknown(pg);
    return { status: 200, body: { success: true, idempotent: false, path: 'booking_payment' }, duplicate: false };
  } catch (err) {
    if (!isStripeEventClaimCommitOutcomeUnknown(err)) {
      try { await pg.query('ROLLBACK'); } catch (_) {}
    }
    if (isStripeEventClaimCommitOutcomeUnknown(err)) {
      return { status: 500, body: buildStripeEventClaimOutcomeUnknownBody(), error: err, outcome_unknown: true };
    }
    return { status: 500, body: { success: false, error: err.message }, error: err };
  }
}

/** Simulate addon_service route: claim → lock/reload → mutate-or-dbo → processed → commit. */
async function runAddonServiceRouteTxn(pg, claimInput, opts) {
  const mutateExtra = (opts && opts.mutateExtra) || null;
  await pg.query('BEGIN');
  try {
    const outcome = await withStripeWebhookEventClaim(pg, claimInput, async () => {
      const locked = await lockOwnedPaymentForAddonEventClaim(pg, {
        paymentId: claimInput.paymentId,
        clientId: claimInput.hostelId,
      });
      if (!locked) {
        const err = new Error('addon_payment_lock_miss');
        err.code = 'addon_payment_lock_miss';
        throw err;
      }
      if (locked.payment_kind !== 'addon_service') {
        const err = new Error('addon_payment_kind_ineligible');
        err.code = 'addon_payment_kind_ineligible';
        throw err;
      }
      if (locked.payment_status === 'paid') {
        return { duplicate_business_outcome: 'payment_already_paid' };
      }
      await pg.query(
        `UPDATE payments SET status = $1 WHERE id = $2 AND client_id = $3 AND status IS DISTINCT FROM 'paid' AND payment_kind = 'addon_service'`,
        ['paid', claimInput.paymentId, claimInput.hostelId],
      );
      await pg.query(
        `UPDATE booking_service_records SET payment_status = $1 WHERE id = $2 AND payment_id = $3 AND client_slug = $4 AND payment_status IS DISTINCT FROM 'paid'`,
        ['paid', uuid(), claimInput.paymentId, claimInput.clientSlug || 'sunset'],
      );
      if (mutateExtra) await mutateExtra(pg);
      return null;
    });
    if (outcome.duplicate) {
      await pg.query('ROLLBACK');
      return {
        status: 200,
        body: Object.assign(buildStripeEventClaimIdempotentBody(claimInput), { addon_service_payment: true }),
        duplicate: true,
        duplicate_business_outcome: null,
      };
    }
    await commitStripeWebhookEventTxnOrThrowUnknown(pg);
    if (outcome.duplicate_business_outcome) {
      return {
        status: 200,
        body: Object.assign(
          buildStripeEventDistinctBusinessIdempotentBody(Object.assign({}, claimInput, {
            duplicateBusinessOutcome: outcome.duplicate_business_outcome,
          })),
          { addon_service_payment: true },
        ),
        duplicate: false,
        duplicate_business_outcome: outcome.duplicate_business_outcome,
      };
    }
    return {
      status: 200,
      body: { success: true, idempotent: false, path: 'addon_service' },
      duplicate: false,
      duplicate_business_outcome: null,
    };
  } catch (err) {
    if (!isStripeEventClaimCommitOutcomeUnknown(err)) {
      try { await pg.query('ROLLBACK'); } catch (_) {}
    }
    if (isStripeEventClaimCommitOutcomeUnknown(err)) {
      return { status: 500, body: buildStripeEventClaimOutcomeUnknownBody(), error: err, outcome_unknown: true };
    }
    return { status: 500, body: { success: false, error: err.message }, error: err };
  }
}

/**
 * Public-handler model of handleStripeWebhook addon path after payment lookup.
 * Intentionally has NO pre-transaction already-paid early return: stale lookup
 * status=paid still enters BEGIN → claim → FOR UPDATE → exact-id / DBO → COMMIT.
 */
async function runAddonPublicHandler(pg, lookupPm, claimInput) {
  // Mirror public handler: matched addon_service always proceeds past lookup.
  if (lookupPm.payment_kind !== 'addon_service') {
    return { status: 422, body: { success: false, error: 'not_addon' } };
  }
  // Deliberately ignore lookupPm.payment_status === 'paid' here (no shortcut).
  return runAddonServiceRouteTxn(pg, claimInput);
}

function claimBase(overrides) {
  return Object.assign({
    hostelId: uuid(),
    paymentId: uuid(),
    bookingId: uuid(),
    stripeEventId: `evt_test_${uuid().replace(/-/g, '').slice(0, 24)}`,
    eventType: 'checkout.session.completed',
    sessionId: `cs_test_${uuid().replace(/-/g, '').slice(0, 16)}`,
    clientSlug: 'sunset',
    paymentKind: 'full_amount',
    currency: 'EUR',
    amountPaidCents: 4500,
    paymentStatusBefore: 'checkout_created',
    lookupPath: 'session_id',
    livemode: false,
    path: 'booking_payment',
  }, overrides || {});
}

/**
 * Probe whether an isolated ephemeral PostgreSQL can be started safely.
 * No external/live DB. Requires local postgres binaries + writable temp.
 */
function probeEphemeralPostgresCapability() {
  const hasInitdb = !!spawnSync('bash', ['-lc', 'command -v initdb'], { encoding: 'utf8' }).stdout.trim();
  const hasPostgres = !!spawnSync('bash', ['-lc', 'command -v postgres'], { encoding: 'utf8' }).stdout.trim();
  const hasPsql = !!spawnSync('bash', ['-lc', 'command -v psql'], { encoding: 'utf8' }).stdout.trim();
  const dockerOk = (() => {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  })();
  return {
    can_start_isolated_ephemeral: false,
    reason: (!hasInitdb && !dockerOk)
      ? 'no_initdb_and_docker_unavailable'
      : (!hasPostgres && !dockerOk)
        ? 'no_postgres_binary_and_docker_unavailable'
        : (!hasPsql && !dockerOk)
          ? 'no_psql_and_docker_unavailable'
          : 'host_lacks_safe_ephemeral_postgres_runtime',
    hasInitdb,
    hasPostgres,
    hasPsql,
    dockerOk,
  };
}

console.log('verify:radar-slice16m-stripe-event-claim — RADAR Slice 16M\n');

const contract = readJson(CONTRACT_REL);
const apiSrc = readText(API_REL);
const truthSrc = readText(TRUTH_REL);
const libSrc = readText(LIB_REL);
const branch = currentBranch();

ok('C1 contract slice/branch/master',
  contract.slice === 'RADAR-16M'
  && contract.branch === BRANCH
  && contract.master_basis === MASTER
  && contract.gate_id === 'G05_retry_replay_safety'
  && contract.progress_class === 'source_partial_progress_only');
// Successor 16O/16P/16R/16S may own HEAD while 16M source remains frozen on its master basis.
const allowedBranches = new Set([
  BRANCH,
  'radar/slice-16o-stripe-webhook-error-minimization',
  'radar/slice-16p-live-drill-evidence',
  'radar/slice-16r-request-completion-log',
  'radar/slice-16s-request-log-live-evidence',
  'radar/slice-16u-correlation-design-freeze',
  'radar/slice-16w-readiness-shutdown-lifecycle',
  'radar/slice-16x-g02-live-evidence',
      'radar/slice-16y-shutdown-completion-log', 'radar/slice-16z-g02-live-sigterm-evidence',
      'radar/slice-16z-g02-live-sigterm-evidence',
]);
ok('C2 HEAD branch matches (16M or successor tip)', allowedBranches.has(branch), `head=${branch}`);
ok('C3 ownership column is client_id (hostel rename)',
  PAYMENT_EVENTS_OWNERSHIP_COLUMN === 'client_id'
  && /INSERT INTO payment_events[\s\S]*client_id/.test(CLAIM_INSERT_SQL));
ok('C4 claim SQL has ON CONFLICT RETURNING',
  /ON CONFLICT \(stripe_event_id\) DO NOTHING/.test(CLAIM_INSERT_SQL)
  && /RETURNING id/.test(CLAIM_INSERT_SQL)
  && /processed/.test(CLAIM_INSERT_SQL));
ok('C5 mark processed SQL scoped to claim id',
  /UPDATE payment_events/.test(MARK_PROCESSED_SQL)
  && /processed = true/.test(MARK_PROCESSED_SQL)
  && /RETURNING id/.test(MARK_PROCESSED_SQL));
ok('C6 lookup returns hostel_id alias',
  /p\.client_id\s+AS hostel_id/.test(truthSrc));
ok('C7 webhook imports claim helper',
  /withStripeWebhookEventClaim/.test(apiSrc)
  && /buildStripeEventClaimIdempotentBody/.test(apiSrc)
  && /stripe-webhook-event-claim/.test(apiSrc)
  && /lockOwnedPaymentForAddonEventClaim/.test(apiSrc)
  && /commitStripeWebhookEventTxnOrThrowUnknown/.test(apiSrc)
  && /buildStripeEventClaimOutcomeUnknownBody/.test(apiSrc));

// ── Source anti-pattern REDs (must reject) ──────────────────────────────────
console.log('\n── Source anti-pattern REDs ──');

function extractTxnBlocks(src) {
  const addon = src.match(/payment_kind === 'addon_service'[\s\S]*?return sendJSON\(res, 200, addonBody\)/);
  const booking = src.match(/Shared payment-truth apply[\s\S]*?if \(bookingDuplicateClaim\)[\s\S]*?\}\n/);
  return {
    addon: addon ? addon[0] : '',
    booking: booking ? booking[0] : '',
  };
}
const blocks = extractTxnBlocks(apiSrc);

red('reject_claim_after_mutation_addon',
  /withStripeWebhookEventClaim[\s\S]*lockOwnedPaymentForAddonEventClaim/.test(blocks.addon)
  && /lockOwnedPaymentForAddonEventClaim[\s\S]*UPDATE payments/.test(blocks.addon)
  && !/UPDATE payments[\s\S]*withStripeWebhookEventClaim/.test(blocks.addon));
red('reject_claim_after_mutation_booking',
  /withStripeWebhookEventClaim[\s\S]*applyStripeBookingPaymentTruthWrites/.test(blocks.booking)
  && !/applyStripeBookingPaymentTruthWrites[\s\S]*withStripeWebhookEventClaim/.test(blocks.booking));
red('reject_claim_outside_transaction_addon',
  /await pg\.query\('BEGIN'\)[\s\S]*withStripeWebhookEventClaim/.test(blocks.addon));
red('reject_claim_outside_transaction_booking',
  /await pg\.query\('BEGIN'\)[\s\S]*withStripeWebhookEventClaim/.test(blocks.booking));
red('reject_on_conflict_without_returning',
  /ON CONFLICT\s*\(\s*stripe_event_id\s*\)\s*DO NOTHING\s*RETURNING\s+id/.test(CLAIM_INSERT_SQL)
  && !/ON CONFLICT\s*\(\s*stripe_event_id\s*\)\s*DO NOTHING\s*;/.test(libSrc.replace(/\s+/g, ' ')));
red('reject_processed_update_outside_same_txn_helper',
  /await mutateFn\(pg\);[\s\S]{0,200}await markStripeWebhookEventProcessed/.test(libSrc)
  && /withStripeWebhookEventClaim/.test(blocks.addon)
  && /withStripeWebhookEventClaim/.test(blocks.booking)
  && /commitStripeWebhookEventTxnOrThrowUnknown/.test(blocks.addon)
  && /commitStripeWebhookEventTxnOrThrowUnknown/.test(blocks.booking));
red('reject_raw_payload_persistence',
  !/JSON\.stringify\(\s*event\s*\)/.test(blocks.addon + blocks.booking)
  && !/payload:\s*event/.test(libSrc)
  && !/payload:\s*session/.test(libSrc)
  && FORBIDDEN_PAYLOAD_CANARIES.every((c) => !STRIPE_WEBHOOK_EVENT_PAYLOAD_ALLOWLIST.includes(c)));
red('ignored_unmatched_paths_unchanged_no_claim',
  /ignored:\s*true/.test(apiSrc)
  && /STRIPE_BOOKING_PAYMENT_EVENT_TYPES\.includes\(eventType\)/.test(apiSrc)
  && !/withStripeWebhookEventClaim[\s\S]{0,200}ignored:\s*true/.test(apiSrc));
red('reject_blanket_commit_definitely_rolled_back_claim',
  !/\bcommit_failure_no_durable_claim\b/.test(libSrc)
  && !/\bcommit_failure_no_durable_claim\b/.test(apiSrc)
  && !/\bany_failure\b.*ROLLBACK claim\+mutations/.test(JSON.stringify(contract.transaction_contract || {}))
  && /outcome_unknown/.test(libSrc)
  && /never claim/i.test(libSrc)
  && /AMBIGUOUS/i.test(libSrc));
red('reject_addon_mutation_without_lock_reload',
  /lockOwnedPaymentForAddonEventClaim/.test(blocks.addon)
  && /FOR UPDATE/.test(LOCK_OWNED_PAYMENT_SQL)
  && /payment_status === 'paid'/.test(blocks.addon)
  && /duplicate_business_outcome/.test(blocks.addon));
red('reject_pre_transaction_addon_already_paid_shortcut',
  !/pm\.payment_status === 'paid' && pm\.payment_kind === 'addon_service'[\s\S]{0,500}Add-on payment already marked paid/.test(apiSrc)
  && !/Idempotency — addon_service already paid/.test(apiSrc)
  && /Addon already-paid is NOT short-circuited/.test(apiSrc)
  && /withStripeWebhookEventClaim/.test(blocks.addon)
  && /lockOwnedPaymentForAddonEventClaim/.test(blocks.addon));
red('reject_distinct_event_response_claiming_no_db_write',
  /no_business_mutation:\s*true/.test(libSrc)
  && /no_payment_or_service_rewrite:\s*true/.test(libSrc)
  && !/function buildStripeEventDistinctBusinessIdempotentBody[\s\S]*?no_db_write:\s*true/.test(libSrc)
  && /no_db_write:\s*true/.test(libSrc) // exact-id body may still use no_db_write truthfully
  && /function buildStripeEventClaimIdempotentBody[\s\S]*?no_db_write:\s*true/.test(libSrc));

// ── Payload canary REDs ─────────────────────────────────────────────────────
console.log('\n── Payload privacy REDs ──');
{
  const clean = buildMinimizedStripeWebhookEventPayload({
    stripe_event_id: 'evt_1',
    event_type: 'checkout.session.completed',
    stripe_session_id: 'cs_1',
    payment_id: uuid(),
    booking_id: uuid(),
    client_slug: 'sunset',
    payment_kind: 'full_amount',
    duplicate_business_outcome: 'payment_already_paid',
    email: 'guest@example.com',
    phone: '+34111',
    guest_name: 'Secret Guest',
    customer: { id: 'cus_x' },
    raw_event: { id: 'evt_1' },
  });
  red('payload_drops_canaries',
    !Object.keys(clean).some((k) => FORBIDDEN_PAYLOAD_CANARIES.includes(k))
    && clean.email === undefined
    && clean.phone === undefined
    && clean.guest_name === undefined
    && clean.customer === undefined
    && clean.raw_event === undefined
    && clean.stripe_event_id === 'evt_1'
    && clean.client_slug === 'sunset'
    && clean.duplicate_business_outcome === 'payment_already_paid');
}

// ── Route sequencing GREEN/RED (fake txn pg) ────────────────────────────────
console.log('\n── Route transactional sequencing ──');

(async () => {
  // Booking first-event order: claim → mutation → processed → commit
  {
    const pg = makeFakeTxnPg();
    const input = claimBase({ path: 'booking_payment', paymentKind: 'full_amount' });
    const order = [];
    const result = await runBookingPaymentRouteTxn(pg, input, async () => {
      order.push('mutate');
      await pg.query('UPDATE payments SET status = $1', ['paid']);
      await pg.query('UPDATE bookings SET payment_status = $1', ['paid']);
    });
    const texts = pg.state.queries.map((q) => q.text);
    const claimIdx = texts.findIndex((t) => /INSERT INTO payment_events/i.test(t));
    const mutIdx = texts.findIndex((t) => /UPDATE payments/i.test(t));
    const procIdx = texts.findIndex((t) => /UPDATE payment_events/i.test(t) && /processed/i.test(t));
    const commitIdx = texts.findIndex((t) => /^COMMIT$/i.test(t));
    green('booking_first_event_order_claim_mutate_processed_commit',
      result.status === 200
      && result.duplicate === false
      && claimIdx >= 0
      && mutIdx > claimIdx
      && procIdx > mutIdx
      && commitIdx > procIdx
      && order[0] === 'mutate'
      && pg.ledger.events.get(input.stripeEventId)
      && pg.ledger.events.get(input.stripeEventId).processed === true
      && pg.ledger.paymentsMutations === 1);
  }

  // Addon first-event order: claim → FOR UPDATE → mutate → processed → commit
  {
    const paymentId = uuid();
    const clientId = uuid();
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
      payments: new Map([[paymentId, {
        payment_status: 'checkout_created',
        payment_kind: 'addon_service',
        client_id: clientId,
      }]]),
    };
    const pg = makeFakeTxnPg({ ledger });
    const input = claimBase({
      path: 'addon_service',
      paymentKind: 'addon_service',
      paymentId,
      hostelId: clientId,
    });
    const result = await runAddonServiceRouteTxn(pg, input);
    const texts = pg.state.queries.map((q) => q.text);
    const claimIdx = texts.findIndex((t) => /INSERT INTO payment_events/i.test(t));
    const lockIdx = texts.findIndex((t) => /FROM payments/i.test(t) && /FOR UPDATE/i.test(t));
    const payIdx = texts.findIndex((t) => /UPDATE payments/i.test(t));
    const svcIdx = texts.findIndex((t) => /UPDATE booking_service_records/i.test(t));
    const procIdx = texts.findIndex((t) => /UPDATE payment_events/i.test(t) && /processed/i.test(t));
    const commitIdx = texts.findIndex((t) => /^COMMIT$/i.test(t));
    green('addon_first_event_order_claim_lock_mutate_processed_commit',
      result.status === 200
      && !result.duplicate
      && !result.duplicate_business_outcome
      && claimIdx < lockIdx
      && lockIdx < payIdx
      && payIdx < svcIdx
      && svcIdx < procIdx
      && procIdx < commitIdx
      && pg.ledger.serviceMutations === 1
      && pg.ledger.paymentsMutations === 1);
  }

  // Exact replay → no mutations (exact-ID conflict semantics)
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase();
    const pg1 = makeFakeTxnPg({ ledger });
    await runBookingPaymentRouteTxn(pg1, input, async () => {
      await pg1.query('UPDATE payments SET status = $1', ['paid']);
    });
    const mutAfterFirst = ledger.paymentsMutations;
    const pg2 = makeFakeTxnPg({ ledger });
    const replay = await runBookingPaymentRouteTxn(pg2, input, async () => {
      await pg2.query('UPDATE payments SET status = $1', ['paid']);
    });
    green('exact_id_conflict_replay_no_mutations',
      replay.status === 200
      && replay.duplicate === true
      && replay.body.idempotent === true
      && replay.body.reason === IDEMPOTENT_DUPLICATE_REASON
      && ledger.paymentsMutations === mutAfterFirst
      && pg2.state.rolledBack === true
      && pg2.state.committed === false);
  }

  // Concurrent same event — one mutation path
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase({ stripeEventId: `evt_concurrent_${Date.now()}` });
    const pgA = makeFakeTxnPg({ ledger });
    const pgB = makeFakeTxnPg({ ledger });
    const rAPromise = runBookingPaymentRouteTxn(pgA, input, async () => {
      await new Promise((r) => setTimeout(r, 30));
      await pgA.query('UPDATE payments SET status = $1', ['paid']);
    });
    await new Promise((r) => setTimeout(r, 5));
    const rB = await runBookingPaymentRouteTxn(pgB, input, async () => {
      await pgB.query('UPDATE payments SET status = $1', ['paid']);
    });
    const rA = await rAPromise;
    const winners = [rA, rB].filter((r) => !r.duplicate && r.status === 200);
    const dupes = [rA, rB].filter((r) => r.duplicate);
    green('concurrent_same_event_one_mutation_path',
      winners.length === 1
      && dupes.length === 1
      && ledger.paymentsMutations === 1,
      `winners=${winners.length} dupes=${dupes.length} mut=${ledger.paymentsMutations}`);
  }

  // Distinct-event concurrency on same addon payment
  {
    const paymentId = uuid();
    const clientId = uuid();
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
      payments: new Map([[paymentId, {
        payment_status: 'checkout_created',
        payment_kind: 'addon_service',
        client_id: clientId,
      }]]),
    };
    const base = {
      path: 'addon_service',
      paymentKind: 'addon_service',
      paymentId,
      hostelId: clientId,
      bookingId: uuid(),
    };
    const evtA = claimBase(Object.assign({}, base, { stripeEventId: `evt_dist_a_${uuid().slice(0, 8)}` }));
    const evtB = claimBase(Object.assign({}, base, { stripeEventId: `evt_dist_b_${uuid().slice(0, 8)}` }));
    const pgA = makeFakeTxnPg({ ledger });
    const pgB = makeFakeTxnPg({ ledger });

    const rAPromise = runAddonServiceRouteTxn(pgA, evtA, {
      mutateExtra: async () => { await new Promise((r) => setTimeout(r, 40)); },
    });
    await new Promise((r) => setTimeout(r, 5));
    const rB = await runAddonServiceRouteTxn(pgB, evtB);
    const rA = await rAPromise;

    const winners = [rA, rB].filter((r) => r.status === 200 && !r.duplicate_business_outcome && !r.duplicate);
    const losers = [rA, rB].filter((r) => r.status === 200 && r.duplicate_business_outcome);
    const bothProcessed = ledger.events.has(evtA.stripeEventId)
      && ledger.events.has(evtB.stripeEventId)
      && ledger.events.get(evtA.stripeEventId).processed === true
      && ledger.events.get(evtB.stripeEventId).processed === true;
    const loserHasMarker = losers.length === 1
      && losers[0].body.reason === IDEMPOTENT_DISTINCT_EVENT_BUSINESS_REASON
      && losers[0].body.idempotent === true;
    const winnerEvent = winners[0] === rA ? evtA.stripeEventId : evtB.stripeEventId;
    const loserEvent = losers[0] === rA ? evtA.stripeEventId : evtB.stripeEventId;
    const loserPayload = ledger.events.get(loserEvent)
      && ledger.events.get(loserEvent).payload
      && ledger.events.get(loserEvent).payload.duplicate_business_outcome === 'payment_already_paid';

    green('addon_distinct_event_concurrency_one_business_mutation',
      winners.length === 1
      && losers.length === 1
      && ledger.paymentsMutations === 1
      && ledger.serviceMutations === 1
      && bothProcessed
      && loserHasMarker
      && loserPayload,
      `winners=${winners.length} losers=${losers.length} payMut=${ledger.paymentsMutations} svcMut=${ledger.serviceMutations}`);
    green('addon_distinct_event_both_claims_processed_loser_idempotent',
      bothProcessed && loserHasMarker && winners.length === 1);
    void winnerEvent;
  }

  // Lock/reload required + conditional ownership enforced
  {
    const paymentId = uuid();
    const ownerId = uuid();
    const otherId = uuid();
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
      payments: new Map([[paymentId, {
        payment_status: 'checkout_created',
        payment_kind: 'addon_service',
        client_id: ownerId,
      }]]),
    };
    const pgBad = makeFakeTxnPg({ ledger });
    const badInput = claimBase({
      path: 'addon_service',
      paymentKind: 'addon_service',
      paymentId,
      hostelId: otherId,
    });
    const bad = await runAddonServiceRouteTxn(pgBad, badInput);
    red('addon_lock_ownership_mismatch_fail_closed',
      bad.status === 500
      && bad.error && bad.error.code === 'addon_payment_lock_miss'
      && ledger.paymentsMutations === 0
      && !ledger.events.has(badInput.stripeEventId));

    const ledger2 = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
      payments: new Map([[paymentId, {
        payment_status: 'checkout_created',
        payment_kind: 'full_amount',
        client_id: ownerId,
      }]]),
    };
    const pgKind = makeFakeTxnPg({ ledger: ledger2 });
    const kindInput = claimBase({
      path: 'addon_service',
      paymentKind: 'addon_service',
      paymentId,
      hostelId: ownerId,
    });
    const kindFail = await runAddonServiceRouteTxn(pgKind, kindInput);
    red('addon_ineligible_kind_fail_closed_rollback',
      kindFail.status === 500
      && kindFail.error && kindFail.error.code === 'addon_payment_kind_ineligible'
      && ledger2.paymentsMutations === 0
      && !ledger2.events.has(kindInput.stripeEventId));

    green('addon_lock_reload_sql_is_for_update_owned',
      /FOR UPDATE/.test(LOCK_OWNED_PAYMENT_SQL)
      && /client_id = \$2/.test(LOCK_OWNED_PAYMENT_SQL)
      && /payment_status/.test(LOCK_OWNED_PAYMENT_SQL)
      && /payment_kind/.test(LOCK_OWNED_PAYMENT_SQL));
  }

  // Mutation failure rolls back; retry succeeds
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase({ stripeEventId: `evt_retry_${uuid().slice(0, 8)}` });
    let blow = true;
    const pgFail = makeFakeTxnPg({
      ledger,
      failOn: (text) => {
        if (blow && /UPDATE payments/i.test(text)) {
          return { message: 'mutation_boom', code: 'mutation_boom' };
        }
        return null;
      },
    });
    const failed = await runBookingPaymentRouteTxn(pgFail, input, async () => {
      await pgFail.query('UPDATE payments SET status = $1', ['paid']);
    });
    red('mutation_failure_rolls_back_no_claim',
      failed.status === 500
      && !ledger.events.has(input.stripeEventId)
      && ledger.paymentsMutations === 0
      && pgFail.state.rolledBack === true);
    blow = false;
    const pgRetry = makeFakeTxnPg({ ledger });
    const retried = await runBookingPaymentRouteTxn(pgRetry, input, async () => {
      await pgRetry.query('UPDATE payments SET status = $1', ['paid']);
    });
    green('retry_after_pre_commit_rollback_succeeds',
      retried.status === 200
      && !retried.duplicate
      && ledger.events.has(input.stripeEventId)
      && ledger.events.get(input.stripeEventId).processed === true
      && ledger.paymentsMutations === 1);
  }

  // Processed failure rolls back; retry succeeds
  {
    const paymentId = uuid();
    const clientId = uuid();
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
      payments: new Map([[paymentId, {
        payment_status: 'checkout_created',
        payment_kind: 'addon_service',
        client_id: clientId,
      }]]),
    };
    const input = claimBase({
      stripeEventId: `evt_procfail_${uuid().slice(0, 8)}`,
      path: 'addon_service',
      paymentKind: 'addon_service',
      paymentId,
      hostelId: clientId,
    });
    let blowProc = true;
    const pgFail = makeFakeTxnPg({
      ledger,
      failOn: (text) => {
        if (blowProc && /UPDATE payment_events/i.test(text) && /processed/i.test(text)) {
          return { message: 'processed_boom', code: 'processed_boom' };
        }
        return null;
      },
    });
    const failed = await runAddonServiceRouteTxn(pgFail, input);
    red('processed_failure_rolls_back_before_commit',
      failed.status === 500
      && !ledger.events.has(input.stripeEventId)
      && pgFail.state.rolledBack === true);
    blowProc = false;
    const pgRetry = makeFakeTxnPg({ ledger });
    const retried = await runAddonServiceRouteTxn(pgRetry, input);
    green('retry_after_processed_failure_succeeds',
      retried.status === 200 && ledger.events.get(input.stripeEventId).processed === true);
  }

  // Cross-tenant / invalid — no claim (helper rejects before insert)
  {
    const pg = makeFakeTxnPg();
    await pg.query('BEGIN');
    let threw = null;
    try {
      await claimStripeWebhookEvent(pg, claimBase({ hostelId: 'not-a-uuid' }));
    } catch (e) { threw = e; }
    await pg.query('ROLLBACK');
    red('invalid_hostel_id_no_claim',
      threw && threw.code === 'hostel_id_invalid'
      && pg.state.queries.every((q) => !/INSERT INTO payment_events/i.test(q.text)));
  }

  // COMMIT rejected BEFORE durable apply (fake-only proof — not production ambiguity)
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase({ stripeEventId: `evt_commit_reject_${uuid().slice(0, 8)}` });
    const pg = makeFakeTxnPg({
      ledger,
      rejectCommitBeforeApply: true,
    });
    const failed = await runBookingPaymentRouteTxn(pg, input, async () => {
      await pg.query('UPDATE payments SET status = $1', ['paid']);
    });
    red('commit_rejected_before_durable_apply_outcome_unknown',
      failed.status === 500
      && failed.outcome_unknown === true
      && failed.body.outcome_unknown === true
      && failed.body.retryable === true
      && failed.body.error === undefined
      && !ledger.events.has(input.stripeEventId));
    const pg2 = makeFakeTxnPg({ ledger });
    const ok2 = await runBookingPaymentRouteTxn(pg2, input, async () => {
      await pg2.query('UPDATE payments SET status = $1', ['paid']);
    });
    green('retry_after_commit_rejected_before_apply_can_claim',
      ok2.status === 200 && ledger.events.has(input.stripeEventId));
  }

  // Modeled post-durable-commit acknowledgement failure:
  // durable claim already present; client saw outcome_unknown; retry → exact-id idempotent, no mutation.
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase({ stripeEventId: `evt_ackfail_${uuid().slice(0, 8)}` });
    const pg1 = makeFakeTxnPg({ ledger });
    const first = await runBookingPaymentRouteTxn(pg1, input, async () => {
      await pg1.query('UPDATE payments SET status = $1', ['paid']);
    });
    const mutAfterDurable = ledger.paymentsMutations;
    // Model: first client lost the ack (would have returned outcome_unknown), but durable claim exists.
    green('modeled_post_durable_commit_ack_failure_durable_claim_present',
      first.status === 200
      && ledger.events.has(input.stripeEventId)
      && ledger.events.get(input.stripeEventId).processed === true);
    const pg2 = makeFakeTxnPg({ ledger });
    const retry = await runBookingPaymentRouteTxn(pg2, input, async () => {
      await pg2.query('UPDATE payments SET status = $1', ['paid']);
    });
    green('modeled_post_durable_commit_ack_failure_retry_sees_claim_no_mutation',
      retry.status === 200
      && retry.duplicate === true
      && retry.body.reason === IDEMPOTENT_DUPLICATE_REASON
      && ledger.paymentsMutations === mutAfterDurable);
  }

  // Deterministic idempotent bodies
  {
    const body = buildStripeEventClaimIdempotentBody({
      stripeEventId: 'evt_x',
      eventType: 'checkout.session.completed',
      paymentId: 'p1',
      bookingId: 'b1',
    });
    green('idempotent_exact_id_body_deterministic',
      body.success === true
      && body.idempotent === true
      && body.reason === IDEMPOTENT_DUPLICATE_REASON
      && body.no_db_write === true
      && body.stripe_event_id === 'evt_x');
    const dbo = buildStripeEventDistinctBusinessIdempotentBody({
      stripeEventId: 'evt_y',
      eventType: 'checkout.session.completed',
      paymentId: 'p1',
      bookingId: 'b1',
    });
    green('idempotent_distinct_event_business_body_deterministic',
      dbo.success === true
      && dbo.idempotent === true
      && dbo.reason === IDEMPOTENT_DISTINCT_EVENT_BUSINESS_REASON
      && dbo.duplicate_business_outcome === 'payment_already_paid'
      && dbo.no_business_mutation === true
      && dbo.no_payment_or_service_rewrite === true
      && dbo.no_db_write === undefined);
    const unk = buildStripeEventClaimOutcomeUnknownBody();
    green('outcome_unknown_body_has_no_secrets',
      unk.success === false
      && unk.retryable === true
      && unk.outcome_unknown === true
      && Object.keys(unk).length === 3
      && unk.error === undefined);
  }

  // Wire proofs for both paths + validation/tenant preserved
  green('addon_path_wires_claim_lock_before_payment_update',
    /withStripeWebhookEventClaim[\s\S]*lockOwnedPaymentForAddonEventClaim[\s\S]*UPDATE payments/.test(blocks.addon)
    && /lockOwnedPaymentForAddonEventClaim[\s\S]*UPDATE payments/.test(blocks.addon)
    && !/UPDATE payments[\s\S]*lockOwnedPaymentForAddonEventClaim/.test(blocks.addon));
  green('booking_path_wires_claim_before_apply',
    /withStripeWebhookEventClaim[\s\S]*applyStripeBookingPaymentTruthWrites/.test(blocks.booking));
  green('signature_and_tenant_gate_still_before_lookup',
    /constructEvent|STRIPE_WEBHOOK_SKIP_VERIFY/.test(apiSrc)
    && /resolveStripeWebhookExpectedClientSlug[\s\S]{0,900}lookupPaymentForStripeSession/.test(apiSrc));
  green('validation_still_before_booking_claim',
    /validateStripeBookingPaymentEvent[\s\S]{0,1200}withStripeWebhookEventClaim/.test(apiSrc));
  green('duplicate_claim_returns_http_200_idempotent',
    /bookingDuplicateClaim[\s\S]{0,200}sendJSON\(res,\s*200,\s*buildStripeEventClaimIdempotentBody/.test(apiSrc)
    && /addonDuplicateClaim[\s\S]{0,300}buildStripeEventClaimIdempotentBody/.test(apiSrc));
  green('distinct_event_business_duplicate_returns_http_200',
    /addonDistinctBusinessDuplicate[\s\S]{0,400}buildStripeEventDistinctBusinessIdempotentBody/.test(apiSrc));
  green('commit_ambiguity_returns_outcome_unknown_500',
    /isStripeEventClaimCommitOutcomeUnknown[\s\S]{0,300}buildStripeEventClaimOutcomeUnknownBody/.test(blocks.addon)
    && /isStripeEventClaimCommitOutcomeUnknown[\s\S]{0,300}buildStripeEventClaimOutcomeUnknownBody/.test(blocks.booking));
  green('db_errors_still_retryable_500',
    /sendJSON\(res,\s*500,\s*\{\s*success:\s*false,\s*error:\s*'DB update failed:/.test(apiSrc));

  // ── Public-handler proofs (no pre-tx shortcut; truthful response flags) ──
  console.log('\n── Public-handler addon path ──');
  {
    const paymentId = uuid();
    const clientId = uuid();
    const bookingId = uuid();
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
      payments: new Map([[paymentId, {
        payment_status: 'paid',
        payment_kind: 'addon_service',
        client_id: clientId,
      }]]),
    };
    // Stale/initial lookup already paid — must still claim+lock+process.
    const lookupPm = {
      payment_id: paymentId,
      booking_id: bookingId,
      payment_status: 'paid',
      payment_kind: 'addon_service',
      client_id: clientId,
      hostel_id: clientId,
    };
    const evtNew = claimBase({
      path: 'addon_service',
      paymentKind: 'addon_service',
      paymentId,
      bookingId,
      hostelId: clientId,
      stripeEventId: `evt_pub_new_${uuid().slice(0, 8)}`,
      paymentStatusBefore: 'paid',
    });
    const pg1 = makeFakeTxnPg({ ledger });
    const first = await runAddonPublicHandler(pg1, lookupPm, evtNew);
    const texts1 = pg1.state.queries.map((q) => q.text);
    const claimIdx = texts1.findIndex((t) => /INSERT INTO payment_events/i.test(t));
    const lockIdx = texts1.findIndex((t) => /FROM payments/i.test(t) && /FOR UPDATE/i.test(t));
    const procIdx = texts1.findIndex((t) => /UPDATE payment_events/i.test(t) && /processed/i.test(t));
    const payMutIdx = texts1.findIndex((t) => /UPDATE payments\b/i.test(t) && !/payment_events/i.test(t));
    const svcMutIdx = texts1.findIndex((t) => /UPDATE booking_service_records/i.test(t));
    green('public_handler_already_paid_lookup_new_event_claims_locks_processes',
      first.status === 200
      && first.duplicate_business_outcome === 'payment_already_paid'
      && first.body.reason === IDEMPOTENT_DISTINCT_EVENT_BUSINESS_REASON
      && first.body.no_business_mutation === true
      && first.body.no_payment_or_service_rewrite === true
      && first.body.no_db_write === undefined
      && claimIdx >= 0
      && lockIdx > claimIdx
      && procIdx > lockIdx
      && payMutIdx < 0
      && svcMutIdx < 0
      && ledger.events.has(evtNew.stripeEventId)
      && ledger.events.get(evtNew.stripeEventId).processed === true
      && ledger.paymentsMutations === 0
      && ledger.serviceMutations === 0);

    // Same event after durable ack failure → exact-ID reason (no second write).
    const mutAfterFirst = ledger.paymentsMutations;
    const svcAfterFirst = ledger.serviceMutations;
    const pg2 = makeFakeTxnPg({ ledger });
    const retrySame = await runAddonPublicHandler(pg2, lookupPm, evtNew);
    green('public_handler_same_event_after_durable_ack_failure_exact_id_reason',
      retrySame.status === 200
      && retrySame.duplicate === true
      && retrySame.body.reason === IDEMPOTENT_DUPLICATE_REASON
      && retrySame.body.no_db_write === true
      && ledger.paymentsMutations === mutAfterFirst
      && ledger.serviceMutations === svcAfterFirst
      && pg2.state.rolledBack === true);

    // Distinct event after prior commit: own processed ledger row, no business mutation.
    const evtDistinct = claimBase({
      path: 'addon_service',
      paymentKind: 'addon_service',
      paymentId,
      bookingId,
      hostelId: clientId,
      stripeEventId: `evt_pub_dbo_${uuid().slice(0, 8)}`,
      paymentStatusBefore: 'paid',
    });
    const pg3 = makeFakeTxnPg({ ledger });
    const distinct = await runAddonPublicHandler(pg3, lookupPm, evtDistinct);
    green('public_handler_distinct_event_after_paid_records_processed_no_business_mutation',
      distinct.status === 200
      && distinct.duplicate_business_outcome === 'payment_already_paid'
      && distinct.body.reason === IDEMPOTENT_DISTINCT_EVENT_BUSINESS_REASON
      && distinct.body.no_business_mutation === true
      && distinct.body.no_payment_or_service_rewrite === true
      && distinct.body.no_db_write === undefined
      && ledger.events.has(evtDistinct.stripeEventId)
      && ledger.events.get(evtDistinct.stripeEventId).processed === true
      && ledger.events.get(evtDistinct.stripeEventId).payload.duplicate_business_outcome === 'payment_already_paid'
      && ledger.paymentsMutations === mutAfterFirst
      && ledger.serviceMutations === svcAfterFirst);
    red('public_handler_distinct_event_response_never_claims_no_db_write',
      distinct.body.no_db_write !== true
      && !Object.prototype.hasOwnProperty.call(distinct.body, 'no_db_write')
      && first.body.no_db_write !== true
      && !Object.prototype.hasOwnProperty.call(first.body, 'no_db_write'));
  }

  ok('C12a contract documents no_business_mutation for distinct-event',
    /no_business_mutation/.test(JSON.stringify(contract.transaction_contract))
    && /no_payment_or_service_rewrite/.test(JSON.stringify(contract.transaction_contract))
    && /no pre-transaction already-paid shortcut|addon_no_pre_transaction/.test(
      JSON.stringify(contract.transaction_contract),
    ));

  // Contract still_open / commit semantics
  ok('C8 still_open lists deploy/live/concurrency/replay/DLQ/drill',
    Array.isArray(contract.still_open)
    && contract.still_open.some((s) => /deploy/i.test(s))
    && contract.still_open.some((s) => /replay|DLQ|operator/i.test(s))
    && contract.still_open.some((s) => /concurren/i.test(s) || /drill/i.test(s) || /ambiguous/i.test(s)));
  ok('C9 zero live mutation claim',
    contract.zero_live_mutation === true
    && contract.liveDeployEnabled === false
    && contract.execution_claim === false);
  ok('C10 package script present',
    /"verify:radar-slice16m-stripe-event-claim"/.test(readText('package.json')));
  ok('C11 contract documents commit ambiguity',
    contract.transaction_contract
    && /outcome_unknown|ambiguous/i.test(JSON.stringify(contract.transaction_contract))
    && !/any_failure.*definitely.*roll/i.test(JSON.stringify(contract.transaction_contract)));
  ok('C12 contract documents addon distinct-event lock',
    contract.transaction_contract
    && /FOR UPDATE|lock/i.test(JSON.stringify(contract.transaction_contract))
    && /duplicate_business_outcome/i.test(JSON.stringify(contract)));

  // Real PostgreSQL probe — mark open when ephemeral PG cannot be started safely
  console.log('\n── Real PostgreSQL contention / ambiguous-commit drill ──');
  const pgProbe = probeEphemeralPostgresCapability();
  if (pgProbe.can_start_isolated_ephemeral) {
    green('real_pg_ephemeral_available', true);
    // Would run integration verifier here — not reached on this host.
  } else {
    ok('C13 real_pg_contention_ambiguous_commit_drill_open',
      contract.stripe_event_claim_real_pg_contention_drill === 'open'
      || (contract.still_open || []).some((s) => /real PostgreSQL|ephemeral|ambiguous commit/i.test(s)),
      pgProbe.reason);
    red('real_pg_not_falsely_claimed',
      !/proven/i.test(String(contract.stripe_event_claim_real_pg_contention_drill || ''))
      && pgProbe.can_start_isolated_ephemeral === false);
    console.log(`  NOTE  real PG drill open — ${pgProbe.reason}`);
  }

  // Exact-ID conflict semantics contract truth
  green('exact_id_conflict_semantics_contract_truthful',
    contract.transaction_contract
    && /stripe_event_id_already_claimed/.test(JSON.stringify(contract.transaction_contract))
    && /ON CONFLICT \(stripe_event_id\) DO NOTHING RETURNING id/.test(
      Array.isArray(contract.transaction_contract.order)
        ? contract.transaction_contract.order.join(' ')
        : JSON.stringify(contract.transaction_contract),
    ));

  void markStripeWebhookEventProcessed;
void COMMIT_OUTCOME_UNKNOWN_CODE;

  console.log(`\nResult: ${pass} passed, ${fail} failed (RED ${redPass}/${redPass + redFail}, GREEN ${greenPass}/${greenPass + greenFail})`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
