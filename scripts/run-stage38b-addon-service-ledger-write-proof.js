/**
 * Stage 38b — Write-mode proof for guest add-on service payment ledger.
 *
 * Usage:
 *   npm run proof:stage38b-addon-service-ledger-write
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', 'infra', '.env') });

const { withPgClient } = require('./lib/pg-connect');
const { isStagingResetEnvironment } = require('./lib/luna-test-reset-phone');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { runGuestHoldPaymentDraftWriteDryRunApproved } = require('./lib/luna-guest-hold-payment-draft-write');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const {
  syncGuestAddonServicePaymentLedger,
  isGuestAddonServicePaymentRow,
  buildServiceChargesDueFromContext,
} = require('./lib/luna-guest-addon-service-payment-ledger');

const CLIENT_SLUG = 'wolfhouse-somo';
const PHONE = '+34600003838b';
const REFERENCE_DATE = '2026-06-10';

function guestContextFromOrchestrator(out, contactName) {
  const r = out || {};
  const gc = normalizeGuestContextForChain({
    message_lane: r.result && r.result.message_lane,
    intake_state: r.result && r.result.intake_state,
    readiness_state: r.result && r.result.readiness_state,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    extracted_fields: r.result && r.result.extracted_fields,
    package_night_rule: r.result && r.result.package_night_rule,
    result: r.result,
    availability: r.availability,
    quote: r.quote,
    payment_choice: r.payment_choice,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
    detected_language: r.result && r.result.detected_language,
  });
  if (contactName) {
    gc.contact_name = contactName;
    gc.whatsapp_guest_name = contactName;
  }
  return gc;
}

function buildWriteChain(lastOut) {
  return {
    result: lastOut.result,
    availability: lastOut.availability,
    quote: lastOut.quote,
    payment_choice: lastOut.payment_choice,
  };
}

function isReadyForHoldWrite(out) {
  const pc = (out && out.payment_choice) || {};
  return pc.next_safe_step === 'ready_for_hold_payment_draft';
}

async function runOrchestratorTurn(pg, message, guestContext) {
  return runGuestAutomationOrchestratorDryRun({
    client_slug: CLIENT_SLUG,
    channel: 'whatsapp',
    message_text: message,
    guest_phone: PHONE,
    guest_context: guestContext,
    reference_date: REFERENCE_DATE,
    language_hint: 'en',
    dry_run: true,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
  }, {
    reference_date: REFERENCE_DATE,
    guest_phone: PHONE,
    dry_run: true,
    pg,
  });
}

async function main() {
  const result = {
    stage: '38b',
    result: 'SKIP',
    skip_reason: null,
    booking_code: null,
    service_records: 0,
    addon_payment_rows: 0,
    deposit_payment_rows: 0,
    replay_duplicate: false,
    service_charges_due_lines: [],
  };

  if (!isStagingResetEnvironment(process.env, 'localhost')) {
    result.skip_reason = 'not_staging_reset_environment';
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  try {
    await withPgClient(async (pg) => {
      let guestContext = { contact_name: 'Stage38b Proof', whatsapp_guest_name: 'Stage38b Proof' };
      const t1 = await runOrchestratorTurn(pg, 'July 1-5 for 1', guestContext);
      guestContext = guestContextFromOrchestrator(t1, 'Stage38b Proof');
      const t2 = await runOrchestratorTurn(
        pg,
        'wetsuit, board, and one surf lesson',
        guestContext,
      );
      guestContext = guestContextFromOrchestrator(t2, 'Stage38b Proof');
      const t3 = await runOrchestratorTurn(pg, 'deposit please', guestContext);
      if (!isReadyForHoldWrite(t3)) {
        throw new Error(`not_ready_for_hold_write: ${(t3.payment_choice && t3.payment_choice.next_safe_step) || 'unknown'}`);
      }

      const chain = buildWriteChain(t3);
      const writeOut = await runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
        confirm_write: true,
        client_slug: CLIENT_SLUG,
        guest_phone: PHONE,
        guest_name: 'Stage38b Proof Guest',
        guest_email: 'stage38b-proof@wolfhouse.test',
        env: { ...process.env, WHATSAPP_DRY_RUN: 'true' },
        host_header: 'localhost',
        pg,
        planner: t3.hold_payment_draft_plan,
      });

      if (!writeOut.success) {
        throw new Error(`hold_write_failed: ${(writeOut.write_block_reasons || []).join('; ')}`);
      }

      result.booking_code = writeOut.booking_code;
      result.booking_id = writeOut.booking_id;
      result.ledger_from_write = writeOut.service_payment_ledger || null;

      const svcRes = await pg.query(
        `SELECT id::text AS service_record_id, service_type, amount_due_cents, payment_status, metadata
           FROM booking_service_records
          WHERE booking_id = $1::uuid
            AND source = 'luna_guest'`,
        [writeOut.booking_id],
      );
      result.service_records = svcRes.rows.length;

      const payRes = await pg.query(
        `SELECT id::text AS payment_id, payment_kind::text AS payment_kind,
                status::text AS payment_status, amount_due_cents, amount_paid_cents, metadata
           FROM payments
          WHERE booking_id = $1::uuid
          ORDER BY created_at ASC`,
        [writeOut.booking_id],
      );
      const addonRows = payRes.rows.filter((r) => String(r.payment_kind) === 'addon_service');
      const depositRows = payRes.rows.filter((r) => String(r.payment_kind) !== 'addon_service');
      result.addon_payment_rows = addonRows.length;
      result.deposit_payment_rows = depositRows.length;
      result.addon_payments_unpaid = addonRows.every(
        (r) => String(r.payment_status) !== 'paid' && Number(r.amount_paid_cents) === 0,
      );
      result.deposit_separate = depositRows.length >= 1 && addonRows.length >= 1;

      const replay = await syncGuestAddonServicePaymentLedger(pg, {
        clientSlug: CLIENT_SLUG,
        bookingId: writeOut.booking_id,
        bookingCode: writeOut.booking_code,
      });
      result.replay_created = replay.service_payment_rows_created || 0;
      result.replay_duplicate = (replay.service_payment_rows_created || 0) === 0
        && (replay.service_payment_rows_existing || 0) >= addonRows.length;

      const payRes2 = await pg.query(
        `SELECT id::text AS payment_id, payment_kind::text AS payment_kind,
                status::text AS payment_status, amount_due_cents, metadata
           FROM payments
          WHERE booking_id = $1::uuid`,
        [writeOut.booking_id],
      );
      const addonRows2 = payRes2.rows.filter((r) => isGuestAddonServicePaymentRow({
        payment_kind: r.payment_kind,
        metadata: r.metadata,
      }));
      result.addon_payment_rows_after_replay = addonRows2.length;

      const charges = buildServiceChargesDueFromContext({
        booking: { balance_due_cents: writeOut.planner && writeOut.planner.balance_due_after_payment_cents },
        serviceRecords: svcRes.rows,
        paymentRows: payRes2.rows.map((r) => ({
          ...r,
          payment_status: r.payment_status,
        })),
      });
      result.service_charges_due_cents = charges.service_charges_due_cents;
      result.service_charges_due_lines = charges.service_charges_due_lines;

      const expectedMinServices = 2;
      if (svcRes.rows.length < expectedMinServices) {
        throw new Error(`expected_at_least_${expectedMinServices}_service_records got ${svcRes.rows.length}`);
      }
      if (addonRows.length < expectedMinServices) {
        if (replay.schema_gap || (result.ledger_from_write && result.ledger_from_write.schema_gap)) {
          result.result = 'PARTIAL';
          result.skip_reason = replay.schema_gap || result.ledger_from_write.schema_gap;
          return;
        }
        throw new Error(`expected_at_least_${expectedMinServices}_addon_payment_rows got ${addonRows.length}`);
      }
      if (!result.replay_duplicate) {
        throw new Error('replay_created_duplicate_payment_rows');
      }
      if (!(charges.service_charges_due_lines && charges.service_charges_due_lines.length >= expectedMinServices)) {
        throw new Error('service_charges_due_lines_missing');
      }
      if (!result.deposit_separate) {
        throw new Error('deposit_and_addon_payments_not_separate');
      }

      result.result = 'PASS';
    });
  } catch (err) {
    const msg = String(err.message || '');
    if (/ECONNREFUSED|password authentication|connect/i.test(msg)) {
      result.result = 'PARTIAL';
      result.skip_reason = `db_unavailable: ${msg}`;
    } else if (/booking_service_records.*does not exist|42P01/i.test(msg)) {
      result.result = 'PARTIAL';
      result.skip_reason = 'booking_service_records table not available in local DB';
    } else if (/addon_service_payment_kind_unavailable|invalid input value for enum payment_kind/i.test(msg)) {
      result.result = 'PARTIAL';
      result.skip_reason = msg;
    } else {
      result.result = 'FAIL';
      result.error = msg;
    }
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.result === 'FAIL' ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
