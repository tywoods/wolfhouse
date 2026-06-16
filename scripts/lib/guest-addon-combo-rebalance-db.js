'use strict';

const fs = require('fs');
const path = require('path');
const { computeWetsuitBoardComboRebalance } = require('./guest-addon-pricing');

const DEFAULT_PRICING_PATH = path.join(
  __dirname,
  '..',
  '..',
  'config',
  'clients',
  'wolfhouse-somo.pricing.json',
);

function loadWetsuitUnitCents() {
  try {
    const cfg = JSON.parse(fs.readFileSync(DEFAULT_PRICING_PATH, 'utf8'));
    const addOn = cfg.add_ons && cfg.add_ons.wetsuit_rental;
    if (addOn && addOn.price_cents) return Number(addOn.price_cents);
  } catch (_) {}
  return 500;
}

async function zeroOutUnpaidWetsuitForCombo(pg, serviceRecordId) {
  const svc = await pg.query(
    `SELECT id, payment_id, amount_due_cents, payment_status, amount_paid_cents
       FROM booking_service_records
      WHERE id = $1
      FOR UPDATE`,
    [serviceRecordId],
  );
  const row = svc.rows[0];
  if (!row || Number(row.amount_due_cents || 0) <= 0) return null;
  if (String(row.payment_status || '').toLowerCase() === 'paid') return null;
  if (Number(row.amount_paid_cents || 0) > 0) return null;

  await pg.query(
    `UPDATE booking_service_records
        SET amount_due_cents = 0,
            payment_status = 'not_requested',
            payment_id = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [
      serviceRecordId,
      JSON.stringify({ combo_waived: true, combo_reason: 'wetsuit_free_with_board' }),
    ],
  );

  if (row.payment_id) {
    await pg.query(
      `UPDATE payments
          SET status = 'cancelled'::payment_record_status,
              amount_due_cents = 0,
              checkout_url = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
          AND status <> 'paid'::payment_record_status`,
      [
        row.payment_id,
        JSON.stringify({ cancelled_reason: 'combo_wetsuit_waived', source: 'combo_rebalance' }),
      ],
    );
  }
  return serviceRecordId;
}

/**
 * Re-pair board/wetsuit combo pricing for one booking (1 board → 1 free wetsuit).
 */
async function rebalanceBookingWetsuitBoardCombo(pg, clientSlug, bookingId) {
  const r = await pg.query(
    `SELECT id::text AS id, service_type, quantity, amount_due_cents, amount_paid_cents,
            payment_status, payment_id, status, metadata
       FROM booking_service_records
      WHERE client_slug = $1
        AND booking_id = $2::uuid
        AND status <> 'cancelled'`,
    [clientSlug, bookingId],
  );

  const { updates } = computeWetsuitBoardComboRebalance(r.rows, {
    wetsuit_unit_cents: loadWetsuitUnitCents(),
  });
  const applied = [];

  for (const upd of updates) {
    if (upd.action === 'zero') {
      const row = await zeroOutUnpaidWetsuitForCombo(pg, upd.id);
      if (row) applied.push({ ...upd, service_record_id: row });
      continue;
    }
    if (upd.action === 'restore') {
      const svc = await pg.query(
        `SELECT id, payment_id, amount_due_cents, amount_paid_cents, payment_status
           FROM booking_service_records
          WHERE id = $1
          FOR UPDATE`,
        [upd.id],
      );
      const existing = svc.rows[0];
      if (!existing) continue;
      if (String(existing.payment_status || '').toLowerCase() === 'paid') continue;
      if (Number(existing.amount_paid_cents || 0) > 0) continue;

      await pg.query(
        `UPDATE booking_service_records
            SET amount_due_cents = $2,
                payment_status = 'not_requested',
                metadata = (
                  COALESCE(metadata, '{}'::jsonb)
                  - 'combo_waived'
                  - 'combo_reason'
                ) || $3::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [
          upd.id,
          upd.amount_due_cents,
          JSON.stringify({
            combo_rebalanced: true,
            combo_rebalanced_at: new Date().toISOString(),
            unit_cents: upd.unit_cents,
            rental_days: upd.rental_days,
            combo_restore_reason: 'board_removed_or_unpaired',
          }),
        ],
      );
      applied.push({ ...upd, service_record_id: upd.id });
    }
  }

  return {
    rebalanced: applied.length > 0,
    updates_applied: applied,
  };
}

module.exports = {
  rebalanceBookingWetsuitBoardCombo,
};
