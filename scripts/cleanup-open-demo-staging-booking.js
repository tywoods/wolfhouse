#!/usr/bin/env node
'use strict';

/**
 * Stage 28f — Cleanup unpaid open-demo staging test holds only.
 *
 * Usage:
 *   node scripts/cleanup-open-demo-staging-booking.js --booking-code WH-G27-...           # dry-run (default)
 *   node scripts/cleanup-open-demo-staging-booking.js --booking-code WH-... --confirm-cleanup
 *   npm run cleanup:open-demo-booking -- --phone +491726422307
 *
 * Safety: staging DB only · unpaid holds only · no Stripe/WhatsApp/confirmation/n8n.
 */

const { Client } = require('pg');
const {
  CLIENT_SLUG,
  UNPAID_PAYMENT_CANCEL_STATUSES,
  assertNotProductionDb,
  assessCleanupEligibility,
  defaultConnectionString,
  parseBaseArgs,
  parsePhoneVariants,
  redactUrl,
  trimStr,
} = require('./lib/open-demo-playground-common');

function printHelp() {
  console.log(`
cleanup-open-demo-staging-booking.js — unpaid staging hold cleanup

Required (one of):
  --booking-code <code>
  --phone <e164>

Flags:
  --dry-run              Preview only (default when --confirm-cleanup absent)
  --confirm-cleanup      Apply writes (cancel booking, release beds, cancel draft payments)
  --allow-paid           Not implemented — still refuses paid bookings with warning
  --limit <n>            Max bookings when using --phone (default: 20)
  --json                 JSON output
  --db-url <url>         Postgres URL override
`);
}

async function resolveClientId(pg) {
  const res = await pg.query('SELECT id::text FROM clients WHERE slug = $1', [CLIENT_SLUG]);
  if (!res.rows[0]) throw new Error(`client not found: ${CLIENT_SLUG}`);
  return res.rows[0].id;
}

async function findBookings(pg, flags) {
  const limit = flags.limit;
  if (flags.bookingCode) {
    const res = await pg.query(
      `SELECT b.id::text AS booking_id, b.booking_code, b.status::text, b.payment_status::text,
              b.phone, b.email, b.check_in::text, b.check_out::text,
              b.confirmation_sent_at::text, b.staff_notes
         FROM bookings b
         JOIN clients c ON c.id = b.client_id
        WHERE c.slug = $1 AND b.booking_code = $2
        ORDER BY b.created_at DESC
        LIMIT 1`,
      [CLIENT_SLUG, flags.bookingCode],
    );
    return res.rows;
  }

  const { raw, e164 } = parsePhoneVariants(flags.phone);
  const res = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.status::text, b.payment_status::text,
            b.phone, b.email, b.check_in::text, b.check_out::text,
            b.confirmation_sent_at::text, b.staff_notes
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND (
          b.phone IN ($2, $3, $4)
          OR REPLACE(COALESCE(b.phone, ''), '+', '') = $5
          OR b.email LIKE 'open-demo+%@example.test'
        )
      ORDER BY b.created_at DESC
      LIMIT $6`,
    [CLIENT_SLUG, e164, raw, flags.phone, raw, limit],
  );
  return res.rows;
}

async function loadPayments(pg, bookingId) {
  const res = await pg.query(
    `SELECT id::text AS payment_id, status::text, payment_kind::text,
            amount_due_cents, amount_paid_cents, stripe_checkout_session_id
       FROM payments
      WHERE booking_id = $1::uuid
      ORDER BY created_at`,
    [bookingId],
  );
  return res.rows;
}

async function loadBeds(pg, bookingId) {
  const res = await pg.query(
    `SELECT bed_code, room_code FROM booking_beds WHERE booking_id = $1::uuid ORDER BY bed_code`,
    [bookingId],
  );
  return res.rows;
}

async function planCleanup(pg, booking, flags) {
  const payments = await loadPayments(pg, booking.booking_id);
  const beds = await loadBeds(pg, booking.booking_id);
  const eligibility = assessCleanupEligibility(booking, payments, { allowPaid: flags.allowPaid });
  const unpaidPayments = payments.filter((p) => UNPAID_PAYMENT_CANCEL_STATUSES.includes(trimStr(p.status).toLowerCase()));

  return {
    booking_code: booking.booking_code,
    booking_id: booking.booking_id,
    status: booking.status,
    payment_status: booking.payment_status,
    confirmation_sent_at: booking.confirmation_sent_at,
    beds_before: beds,
    payments_before: payments,
    eligible: eligibility.eligible,
    block_reasons: eligibility.reasons,
    warning: eligibility.warning || null,
    actions: eligibility.eligible ? {
      booking_status_after: 'cancelled',
      beds_to_release: beds.length,
      payments_to_cancel: unpaidPayments.map((p) => ({
        payment_id: p.payment_id,
        status_before: p.status,
        status_after: 'cancelled',
      })),
      staff_notes_append: `[stage28f_cleanup ${new Date().toISOString()}] test hold cancelled via cleanup-open-demo-staging-booking.js`,
    } : null,
  };
}

async function applyCleanup(pg, clientId, plan) {
  const note = plan.actions.staff_notes_append;
  await pg.query('BEGIN');
  try {
    const delBeds = await pg.query(
      'DELETE FROM booking_beds WHERE booking_id = $1::uuid AND client_id = $2::uuid',
      [plan.booking_id, clientId],
    );
    let paymentsCancelled = 0;
    for (const p of plan.actions.payments_to_cancel) {
      const upd = await pg.query(
        `UPDATE payments SET status = 'cancelled', updated_at = NOW()
          WHERE id = $1::uuid AND booking_id = $2::uuid AND status = ANY($3::payment_record_status[])`,
        [p.payment_id, plan.booking_id, UNPAID_PAYMENT_CANCEL_STATUSES],
      );
      paymentsCancelled += upd.rowCount || 0;
    }
    const updBooking = await pg.query(
      `UPDATE bookings
          SET status = 'cancelled',
              staff_notes = TRIM(BOTH FROM COALESCE(staff_notes, '') || E'\\n' || $3),
              updated_at = NOW()
        WHERE id = $1::uuid AND client_id = $2::uuid
        RETURNING booking_code, status::text`,
      [plan.booking_id, clientId, note],
    );
    await pg.query('COMMIT');
    return {
      beds_released: delBeds.rowCount || 0,
      payments_cancelled: paymentsCancelled,
      booking_after: updBooking.rows[0] || null,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

async function main() {
  const flags = parseBaseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  if (flags.unknown && flags.unknown.length) {
    console.error(`Unknown arguments: ${flags.unknown.join(', ')}`);
    process.exit(1);
  }
  if (!flags.bookingCode && !flags.phone) {
    console.error('Required: --booking-code or --phone');
    process.exit(1);
  }

  const dbUrl = flags.dbUrl || defaultConnectionString();
  assertNotProductionDb(dbUrl);

  const pg = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('azure') ? { rejectUnauthorized: false } : undefined });
  await pg.connect();

  const out = {
    tool: 'cleanup-open-demo-staging-booking',
    dry_run: flags.dryRun,
    confirm_cleanup: flags.confirmCleanup,
    database: redactUrl(dbUrl),
    targets: [],
    applied: [],
    blocked: [],
    verdict: 'PASS',
  };

  try {
    const clientId = await resolveClientId(pg);
    const bookings = await findBookings(pg, flags);
    if (!bookings.length) {
      out.verdict = 'FAIL';
      out.error = 'no matching bookings found';
      throw new Error(out.error);
    }

    for (const booking of bookings) {
      const plan = await planCleanup(pg, booking, flags);
      out.targets.push(plan);
      if (!plan.eligible) {
        out.blocked.push({
          booking_code: plan.booking_code,
          reasons: plan.block_reasons,
          warning: plan.warning,
        });
        continue;
      }
      if (flags.dryRun) {
        out.applied.push({
          booking_code: plan.booking_code,
          mode: 'dry_run',
          would_apply: plan.actions,
        });
        continue;
      }
      const result = await applyCleanup(pg, clientId, plan);
      out.applied.push({
        booking_code: plan.booking_code,
        mode: 'write',
        result,
      });
    }

    if (out.blocked.length && !out.applied.some((a) => a.mode === 'write')) {
      out.verdict = out.applied.length ? 'PARTIAL' : 'BLOCKED';
    }
    if (out.blocked.length && out.applied.every((a) => a.mode === 'dry_run')) {
      out.verdict = 'BLOCKED';
    }

    if (flags.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log('\n── Open Demo Staging Cleanup ──');
      console.log(`Database: ${out.database}`);
      console.log(`Mode: ${flags.dryRun ? 'DRY-RUN (no writes)' : 'WRITE (--confirm-cleanup)'}`);
      for (const plan of out.targets) {
        console.log(`\n${plan.booking_code} status=${plan.status} payment_status=${plan.payment_status}`);
        console.log(`  beds: ${(plan.beds_before || []).map((b) => b.bed_code).join(', ') || '(none)'}`);
        console.log(`  payments: ${(plan.payments_before || []).map((p) => `${p.payment_id}:${p.status}`).join(', ') || '(none)'}`);
        if (!plan.eligible) {
          console.log(`  BLOCKED: ${plan.block_reasons.join(', ')}`);
          if (plan.warning) console.log(`  WARNING: ${plan.warning}`);
        } else if (flags.dryRun) {
          console.log(`  would cancel booking, release ${plan.actions.beds_to_release} bed(s), cancel ${plan.actions.payments_to_cancel.length} payment row(s)`);
        } else {
          const applied = out.applied.find((a) => a.booking_code === plan.booking_code && a.mode === 'write');
          if (applied) {
            console.log(`  APPLIED: beds_released=${applied.result.beds_released} payments_cancelled=${applied.result.payments_cancelled}`);
          }
        }
      }
      console.log(`\nVerdict: ${out.verdict}\n`);
    }

    process.exit(out.verdict === 'FAIL' ? 1 : 0);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(`cleanup failed: ${err.message}`);
  process.exit(1);
});
