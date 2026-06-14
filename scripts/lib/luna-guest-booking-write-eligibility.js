/**
 * Phase 13b — Luna guest booking write eligibility evaluator (read-only).
 *
 * Maps a Phase 12 dry-run plan + caller input + env flags to a write-readiness
 * decision. Performs no DB writes, no HTTP calls, no Stripe/WhatsApp/n8n.
 *
 * @module luna-guest-booking-write-eligibility
 */

'use strict';

const WRITE_ROUTE = 'POST /staff/bot/bookings/create';

const VALID_PAYMENT_CHOICES = new Set(['deposit', 'full']);

const ELIGIBILITY_SAFETY_FLAGS = Object.freeze({
  creates_booking:     false,
  creates_payment:     false,
  creates_stripe_link: false,
  sends_whatsapp:      false,
  calls_n8n:           false,
});

const DRY_RUN_SAFETY_CHECKS = [
  ['dry_run',             true],
  ['preview_only',        true],
  ['no_write_performed',  true],
  ['creates_booking',     false],
  ['creates_payment',     false],
  ['creates_stripe_link', false],
  ['sends_whatsapp',      false],
  ['calls_n8n',           false],
];

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function resolvePhone(plan, input) {
  const p = plan || {};
  const i = input || {};
  return trimStr(p.guest_phone) || trimStr(p.phone)
    || trimStr(i.guest_phone) || trimStr(i.phone) || trimStr(i.from);
}

function resolvePaymentChoice(plan, input) {
  const raw = trimStr((input || {}).payment_choice).toLowerCase();
  const compact = raw.replace(/[^a-z0-9_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (VALID_PAYMENT_CHOICES.has(compact)) return compact;
  if (['full amount', 'pay full', 'pay full amount', 'all now', 'pay all', 'everything', 'whole amount'].includes(compact)) return 'full';
  if (['pay deposit', 'the deposit', 'deposit only'].includes(compact)) return 'deposit';
  const missing = (plan && plan.booking_preview && plan.booking_preview.missing_fields) || [];
  if (missing.includes('payment_choice')) return '';
  return '';
}

function baseResult() {
  return Object.assign({}, ELIGIBILITY_SAFETY_FLAGS, {
    write_ready:         false,
    blocked_reasons:     [],
    required_approvals:  [],
    would_call:          [],
    safe_next_step:      'keep_dry_run',
    dry_run_anchor:      'POST /staff/bot/booking-dry-run',
  });
}

function resolveSafeNextStep(blockedReasons, plan) {
  const reasons = blockedReasons || [];
  const next = plan && plan.next_action;

  if (reasons.some((r) => r.startsWith('gate_'))) return 'handoff_to_staff';
  if (reasons.includes('payment_choice_missing')) return 'ask_deposit_or_full_payment';
  if (reasons.some((r) => r.startsWith('availability_'))) return 'handoff_to_staff';
  if (reasons.some((r) => r.startsWith('guest_') || r.startsWith('booking_'))) {
    return 'ask_missing_details';
  }
  if (reasons.some((r) => r.startsWith('dry_run_unsafe'))) return 'keep_dry_run';
  if (next === 'ask_missing_details') return 'ask_missing_details';
  if (next === 'ask_deposit_or_full_payment') return 'ask_deposit_or_full_payment';
  if (next === 'handoff_to_staff') return 'handoff_to_staff';
  return 'keep_dry_run';
}

/**
 * Evaluate whether a dry-run plan is ready for gated booking create (13c).
 *
 * @param {object} dryRunPlan - output from runLunaGuestBookingDryRun()
 * @param {object} [input] - original guest payload + write intent (confirm, idempotency_key, payment_choice, etc.)
 * @param {object} [env] - env bag; defaults to process.env
 * @returns {object}
 */
function evaluateLunaBookingWriteEligibility(dryRunPlan, input, env) {
  const plan = dryRunPlan || {};
  const src  = input || {};
  const e    = env || process.env;

  const blockedReasons    = [];
  const requiredApprovals = [];

  // ── 1. Dry-run safety flags ───────────────────────────────────────────────
  for (const [key, expected] of DRY_RUN_SAFETY_CHECKS) {
    if (plan[key] !== expected) {
      blockedReasons.push(`dry_run_unsafe:${key}`);
    }
  }

  // ── 2. Guest automation gate ──────────────────────────────────────────────
  const gate = plan.gate || {};
  if (gate.can_continue_guest_automation !== true) {
    blockedReasons.push('gate_automation_blocked');
  }
  if (gate.bot_paused === true) {
    blockedReasons.push('gate_bot_paused');
  }
  if (gate.live_send_blocked === true) {
    blockedReasons.push('gate_live_send_blocked');
  }

  // ── 3. Guest identity ─────────────────────────────────────────────────────
  const phone = resolvePhone(plan, src);
  if (!phone) {
    blockedReasons.push('guest_phone_missing');
  }

  const guestName = trimStr(src.guest_name);
  const missingFields = (plan.booking_preview && plan.booking_preview.missing_fields) || [];
  if (!guestName && missingFields.includes('guest_name')) {
    blockedReasons.push('guest_name_missing');
  }

  // ── 4. Booking details ────────────────────────────────────────────────────
  const clientSlug = trimStr(plan.client_slug) || trimStr(src.client_slug);
  if (!clientSlug) {
    blockedReasons.push('booking_client_slug_missing');
  }

  const availability = plan.availability || {};
  const quote        = plan.booking_preview && plan.booking_preview.quote;

  const checkIn = trimStr(availability.check_in) || trimStr(src.check_in);
  const checkOut = trimStr(availability.check_out) || trimStr(src.check_out);
  if (!checkIn || !checkOut) {
    blockedReasons.push('booking_dates_missing');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    blockedReasons.push('booking_dates_invalid');
  } else if (checkOut <= checkIn) {
    blockedReasons.push('booking_dates_invalid');
  }

  const guestCount = availability.guest_count != null
    ? Number(availability.guest_count)
    : (src.guest_count != null ? Number(src.guest_count) : null);
  if (guestCount == null || guestCount < 1) {
    blockedReasons.push('booking_guest_count_missing');
  }

  const packageCode = trimStr(src.package_code).toLowerCase()
    || (quote && quote.package_code ? trimStr(quote.package_code).toLowerCase() : '');
  if (!packageCode || packageCode === 'manual_override' || missingFields.includes('package_code')) {
    blockedReasons.push('booking_package_missing');
  }

  if (!quote || quote.success !== true) {
    blockedReasons.push('booking_quote_missing_or_failed');
  }

  if (plan.booking_preview && plan.booking_preview.has_missing_fields === true) {
    blockedReasons.push('booking_required_fields_missing');
  }

  // ── 5. Availability / bed selection ───────────────────────────────────────
  if (availability.skipped === true) {
    blockedReasons.push('availability_not_checked');
  }
  if (availability.has_enough_beds !== true) {
    blockedReasons.push('availability_insufficient_beds');
  }
  const bedCodes = Array.isArray(availability.selected_bed_codes)
    ? availability.selected_bed_codes.filter(Boolean)
    : [];
  if (bedCodes.length === 0) {
    blockedReasons.push('availability_selected_beds_missing');
  } else if (guestCount != null && bedCodes.length < guestCount) {
    blockedReasons.push('availability_selected_beds_insufficient');
  }

  // ── 6. Payment choice (deposit / full) ────────────────────────────────────
  const paymentChoice = resolvePaymentChoice(plan, src);
  if (!paymentChoice) {
    blockedReasons.push('payment_choice_missing');
  }

  // ── 7. Planned action alignment (informational block) ───────────────────────
  const planned = Array.isArray(plan.planned_actions) ? plan.planned_actions : [];
  if (!planned.includes('would_create_booking_after_approval')) {
    blockedReasons.push('dry_run_plan_not_ready_for_booking');
  }

  // ── 8. Env / explicit approvals (required for write_ready) ────────────────
  if (e.BOT_BOOKING_ENABLED !== 'true') {
    requiredApprovals.push('BOT_BOOKING_ENABLED');
  }
  if (src.confirm !== true) {
    requiredApprovals.push('confirm_true');
  }
  const idempotencyKey = trimStr(src.idempotency_key);
  if (!idempotencyKey) {
    requiredApprovals.push('idempotency_key');
  }

  const writeReady = blockedReasons.length === 0 && requiredApprovals.length === 0;

  const result = baseResult();
  result.blocked_reasons    = blockedReasons;
  result.required_approvals = requiredApprovals;
  result.safe_next_step     = writeReady
    ? 'booking_create_gated'
    : resolveSafeNextStep(blockedReasons, plan);

  if (writeReady) {
    result.write_ready = true;
    result.would_call  = [WRITE_ROUTE];
  }

  return result;
}

module.exports = {
  evaluateLunaBookingWriteEligibility,
  WRITE_ROUTE,
  ELIGIBILITY_SAFETY_FLAGS,
  VALID_PAYMENT_CHOICES,
};
