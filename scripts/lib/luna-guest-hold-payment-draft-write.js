'use strict';

/**
 * Stage 27n — Gated guest hold + payment draft write (staging/local only).
 *
 * After Stage 27m planner is ready, creates booking hold + quote snapshot +
 * draft payment via existing hold/payment table patterns. No Stripe link.
 */

const { withPgClient } = require('./pg-connect');
const { isStagingResetEnvironment } = require('./luna-test-reset-phone');
const {
  runGuestHoldPaymentDraftPlannerDryRun,
} = require('./luna-guest-hold-payment-draft-planner');
const {
  parseHoldInput,
  resolveClientId,
  selectActiveHoldGuard,
  upsertBookingHold,
  EXECUTE_HOLD_STATUSES,
} = require('./main-booking-hold-pg-sql');
const {
  attachAllGuestAddonServices,
} = require('./luna-guest-addon-service-attach');
const { upsertBookingTransfer } = require('./booking-transfers');
const { buildGuestTransferScheduledAtLocal } = require('./luna-guest-transfer-times-update');
const { parseDatetimeLocalInTimezone } = require('./staff-booking-transfers-routes');
const { getClientTransferConfig } = require('./client-transfer-config');
const { mergePendingServiceAttachContext } = require('./luna-guest-pending-service-attach');

const HOLD_EXPIRES_IN_HOURS = 6;
const DEFAULT_CLIENT = 'wolfhouse-somo';
const WRITE_SOURCE = 'luna_guest_hold_payment_draft_27n';

const WRITE_SAFETY = Object.freeze({
  dry_run: false,
  sends_whatsapp: false,
  live_send_blocked: true,
  stripe_link_created: false,
  creates_stripe_link: false,
  payment_link_sent: false,
  whatsapp_sent: false,
  calls_n8n: false,
});

const VALID_WRITE_STATUSES = Object.freeze([
  'not_ready',
  'created',
  'reused_existing',
  'needs_staff_review',
  'error',
]);

const REPLY_TEMPLATES = {
  en: {
    intro: "Hi! I'm Luna from Wolfhouse",
    ready: 'Thanks — the secure payment step can be prepared next. I am not confirming the booking, saying a payment link is ready, or recording payment received.',
    not_ready: 'Thanks — the booking hold and payment draft are not ready yet. Our team will help with the next step.',
    reused: 'Thanks — I found your existing hold and payment draft for this stay. The secure payment step can be prepared next when approved.',
    handoff: 'Thanks — I am handing this to our team before creating the hold and payment draft.',
    blocked: 'Thanks for your patience — this write path is not enabled in this environment.',
    error: 'Thanks — something went wrong preparing the hold and payment draft. Our team will follow up.',
  },
};

function tpl(lang) {
  return REPLY_TEMPLATES[lang] || REPLY_TEMPLATES.en;
}

function buildReply(lang, key) {
  const L = tpl(lang);
  return `${L.intro} 🌊 — ${L[key]}`;
}

function resolveLang(chainResult) {
  const r = chainResult && chainResult.result;
  return (r && r.detected_language) || 'en';
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeChain(chainResult) {
  const c = chainResult || {};
  return {
    result: c.result || {},
    availability: c.availability || {},
    quote: c.quote || {},
    payment_choice: c.payment_choice || {},
  };
}

function isGuestHoldPaymentDraftWriteEnvironment(env, hostHeader) {
  return isStagingResetEnvironment(env || process.env, hostHeader || '');
}

function confirmWriteApproved(context) {
  const ctx = context || {};
  return ctx.confirm_write === true || ctx.confirmWrite === true;
}

/**
 * Hard gate before any planner/DB work for writes.
 */
function shouldAllowGuestHoldPaymentDraftWrite(chainResult, context) {
  const ctx = context || {};
  const env = ctx.env || process.env;
  if (!isGuestHoldPaymentDraftWriteEnvironment(env, ctx.host_header)) {
    return { allowed: false, reasons: ['production_or_unknown_environment_blocked'] };
  }
  if (!confirmWriteApproved(ctx)) {
    return { allowed: false, reasons: ['confirm_write_required'] };
  }
  const chain = normalizeChain(chainResult);
  const pc = chain.payment_choice;
  if (pc.next_safe_step !== 'ready_for_hold_payment_draft') {
    return { allowed: false, reasons: ['payment_choice_not_ready_for_hold_payment_draft'] };
  }
  return { allowed: true, reasons: [] };
}

function mapPaymentKind(plannerKind) {
  return plannerKind === 'full_payment' ? 'full_amount' : 'deposit_only';
}

function proposeGuestHoldExpiresAt(now = new Date()) {
  return new Date(now.getTime() + HOLD_EXPIRES_IN_HOURS * 60 * 60 * 1000).toISOString();
}

function deriveBookingCode(idempotencyKey) {
  const hex = trimStr(idempotencyKey).replace(/[^a-f0-9]/gi, '').slice(0, 10).toUpperCase();
  return `WH-G27-${hex || 'DRAFT'}`;
}

function syntheticGuestEmailFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `open-demo+${digits}@example.test`;
}

async function loadPaymentDraftForBooking(pg, bookingId, clientId) {
  if (!pg || !bookingId || !clientId) return null;
  const payRes = await pg.query(
    `SELECT id::text AS payment_draft_id,
            status::text AS status,
            payment_kind::text AS payment_kind,
            amount_due_cents,
            checkout_url,
            stripe_checkout_session_id
       FROM payments
      WHERE booking_id = $1::uuid
        AND client_id = $2
        AND status IN ('draft', 'checkout_created', 'pending')
      ORDER BY created_at DESC
      LIMIT 1`,
    [bookingId, clientId],
  );
  return payRes.rows[0] || null;
}

async function ensurePaymentDraftOnBooking(pg, {
  clientId,
  bookingId,
  planner,
  paymentIdemKey,
  idempotencyKey,
}) {
  const existing = await loadPaymentDraftForBooking(pg, bookingId, clientId);
  if (existing) return existing;
  const payKind = mapPaymentKind(planner.payment_kind);
  const pmMeta = {
    source: WRITE_SOURCE,
    idempotency_key: paymentIdemKey,
    guest_intake_idempotency_key: idempotencyKey,
    payment_choice: planner.payment_kind,
    is_payment_truth: false,
    stage: '27n_reuse',
  };
  const payIns = await pg.query(
    `INSERT INTO payments (
       client_id, booking_id, status, payment_kind, currency,
       amount_due_cents, amount_paid_cents, metadata
     ) VALUES (
       $1, $2::uuid, 'draft'::payment_record_status, $3::payment_kind, 'EUR',
       $4, 0, $5::jsonb
     ) RETURNING id::text AS payment_draft_id, amount_due_cents, status::text AS status,
               payment_kind::text AS payment_kind`,
    [
      clientId,
      bookingId,
      payKind,
      planner.payment_amount_cents,
      JSON.stringify(pmMeta),
    ],
  );
  return payIns.rows[0] || null;
}

function buildWriteBlockedResponse(chainResult, context, reasons, replyKey) {
  const lang = resolveLang(chainResult);
  return {
    success: false,
    ...WRITE_SAFETY,
    write_attempted: false,
    write_status: 'not_ready',
    booking_id: null,
    booking_code: null,
    payment_draft_id: null,
    hold_expires_at: null,
    created_records: null,
    reused_records: null,
    write_block_reasons: reasons,
    next_safe_step: 'keep_dry_run',
    proposed_luna_reply: buildReply(lang, replyKey || 'blocked'),
  };
}

function buildWriteNotReadyResponse(chainResult, planner, reasons) {
  const lang = resolveLang(chainResult);
  const status = planner.plan_handoff_required ? 'needs_staff_review' : 'not_ready';
  return {
    success: false,
    ...WRITE_SAFETY,
    write_attempted: false,
    write_status: status,
    planner,
    booking_id: null,
    booking_code: null,
    payment_draft_id: null,
    hold_expires_at: null,
    created_records: null,
    reused_records: null,
    write_block_reasons: reasons,
    next_safe_step: status === 'needs_staff_review' ? 'staff_handoff_required' : 'keep_dry_run',
    proposed_luna_reply: buildReply(lang, status === 'needs_staff_review' ? 'handoff' : 'not_ready'),
  };
}

async function lookupExistingHoldPaymentDraft(pg, clientSlug, idempotencyKey) {
  const bookingRes = await pg.query(
    `SELECT b.id::text AS booking_id,
            b.booking_code,
            b.status::text AS status,
            b.payment_status::text AS payment_status,
            b.hold_expires_at,
            b.phone,
            b.check_in::text AS check_in,
            b.check_out::text AS check_out
     FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1
       AND b.metadata->>'idempotency_key' = $2
       AND b.status::text IN ('hold', 'payment_pending')
       AND b.payment_status::text NOT IN ('deposit_paid', 'paid')
       AND (b.hold_expires_at IS NULL OR b.hold_expires_at > NOW())
     ORDER BY b.created_at DESC
     LIMIT 1`,
    [clientSlug, idempotencyKey],
  );
  if (!bookingRes.rows.length) return null;

  const booking = bookingRes.rows[0];
  const payRes = await pg.query(
    `SELECT id::text AS payment_draft_id,
            status::text AS status,
            payment_kind::text AS payment_kind,
            amount_due_cents,
            checkout_url,
            stripe_checkout_session_id
     FROM payments
     WHERE booking_id = $1::uuid
       AND metadata->>'idempotency_key' = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [booking.booking_id, `ghpd-pay-${idempotencyKey}`],
  );

  return {
    booking,
    payment: payRes.rows[0] || null,
  };
}

function formatReuseResponse(chainResult, planner, existing, attachMeta) {
  const lang = resolveLang(chainResult);
  const b = existing.booking;
  const p = existing.payment;
  const attach = attachMeta || {};
  return {
    success: true,
    ...WRITE_SAFETY,
    write_attempted: true,
    write_status: 'reused_existing',
    planner,
    booking_id: b.booking_id,
    booking_code: b.booking_code,
    payment_draft_id: p ? p.payment_draft_id : null,
    hold_expires_at: b.hold_expires_at || null,
    attached_manual_services: attach.attached_manual_services || [],
    created_records: null,
    reused_records: {
      booking_hold: {
        booking_id: b.booking_id,
        booking_code: b.booking_code,
        status: b.status,
      },
      payment_draft: p ? {
        payment_draft_id: p.payment_draft_id,
        status: p.status,
        payment_kind: p.payment_kind,
        amount_due_cents: p.amount_due_cents,
      } : null,
    },
    write_block_reasons: [],
    next_safe_step: 'ready_for_stripe_test_link',
    proposed_luna_reply: buildReply(lang, 'reused'),
  };
}

async function attachGuestBookingTransfers(pg, {
  clientSlug,
  bookingId,
  booking,
  fields,
}) {
  const ti = (fields && (fields.transfer_info || fields.transfer_interest)) || null;
  if (!ti || ti.interested !== true) {
    return { attached_transfers: [], transfer_attach_skipped: 'not_requested' };
  }

  const directions = ['arrival', 'departure'];
  const bookingForTransfer = booking || {};
  const usedDefaultTimes = !ti.arrival_time && !ti.departure_time;

  const attached = [];
  const errors = [];
  for (const direction of directions) {
    try {
      const guestTime = direction === 'departure'
        ? (ti.departure_time || null)
        : (ti.arrival_time || null);
      const tz = getClientTransferConfig(clientSlug).timezone || 'Europe/Madrid';
      const localAt = buildGuestTransferScheduledAtLocal({
        direction,
        booking: bookingForTransfer,
        timeStr: guestTime,
        client_slug: clientSlug,
      });
      const scheduledAt = localAt && localAt.includes('T')
        ? parseDatetimeLocalInTimezone(localAt, tz)
        : localAt;
      const row = await upsertBookingTransfer(pg, {
        client_slug: clientSlug,
        booking_id: bookingId,
        direction,
        booking: bookingForTransfer,
        source: 'luna',
        transfer: {
          airport_code: ti.airport_code || 'SDR',
          flight_number: ti.flight_number || null,
          scheduled_at: scheduledAt,
          guest_count: bookingForTransfer.guest_count,
          status: 'requested',
          notes: ti.deferred
            ? 'Guest will send flight details later'
            : (usedDefaultTimes
              ? 'Booked via Luna — default transfer time (guest did not specify)'
              : 'Booked via Luna guest intake'),
        },
      });
      attached.push({ direction, transfer_id: row && (row.id || row.transfer_id) });
    } catch (err) {
      errors.push({ direction, error: err.message || String(err) });
    }
  }

  return {
    attached_transfers: attached,
    transfer_attach_errors: errors.length ? errors : undefined,
  };
}

async function executeHoldPaymentDraftWrite(pg, chainResult, planner, context) {
  const ctx = context || {};
  const chain = normalizeChain(chainResult);
  const fields = chain.result.extracted_fields || {};
  const attachFields = mergePendingServiceAttachContext(fields, chain.result);
  const quote = chain.quote;
  const clientSlug = trimStr(ctx.client_slug) || DEFAULT_CLIENT;
  const idempotencyKey = planner.idempotency_key_preview;
  const paymentIdemKey = `ghpd-pay-${idempotencyKey}`;

  const guestName = trimStr(fields.guest_name) || trimStr(ctx.guest_name) || 'Guest';
  const guestPhone = trimStr(ctx.guest_phone) || trimStr(fields.guest_phone) || trimStr(fields.phone);
  const guestEmail = trimStr(ctx.guest_email)
    || trimStr(fields.guest_email)
    || syntheticGuestEmailFromPhone(guestPhone);

  if (!guestPhone) {
    return { error: 'missing_guest_phone', handoff: true };
  }
  if (!guestEmail) {
    return { error: 'missing_guest_email', handoff: true };
  }

  const clientRes = await resolveClientId(pg, clientSlug);
  if (clientRes.error) return { error: clientRes.error };

  const existing = await lookupExistingHoldPaymentDraft(pg, clientSlug, idempotencyKey);
  if (existing && existing.booking) {
    const clientResReuse = await resolveClientId(pg, clientSlug);
    if (!existing.payment) {
      existing.payment = await ensurePaymentDraftOnBooking(pg, {
        clientId: clientResReuse.client_id,
        bookingId: existing.booking.booking_id,
        planner,
        paymentIdemKey,
        idempotencyKey,
      });
    }
    const attach = await attachAllGuestAddonServices(pg, {
      clientSlug,
      bookingId: existing.booking.booking_id,
      bookingCode: existing.booking.booking_code,
      guestName,
      extractedFields: attachFields,
      resultContext: chain.result,
      quote,
      clientId: clientResReuse.client_id,
      writeSource: WRITE_SOURCE,
    });
    const transferAttach = await attachGuestBookingTransfers(pg, {
      clientSlug,
      bookingId: existing.booking.booking_id,
      booking: existing.booking,
      fields: attachFields,
    });
    return { reused: existing, ...attach, ...transferAttach };
  }

  const bookingCode = deriveBookingCode(idempotencyKey);
  const packageRaw = planner.planned_records?.booking_hold?.package_code
    || fields.package_interest;
  const packageCode = packageRaw === 'accommodation_only' ? 'no_package' : packageRaw;

  const holdInput = parseHoldInput({
    client_slug: clientSlug,
    booking_code: bookingCode,
    guest_name: guestName,
    email: guestEmail,
    phone: guestPhone,
    check_in: fields.check_in,
    check_out: fields.check_out,
    guest_count: fields.guest_count,
    room_type: fields.room_type || 'shared',
    package_code: packageCode,
    notes: WRITE_SOURCE,
  });

  const activeGuard = await selectActiveHoldGuard(pg, clientRes.client_id, holdInput);
  if (activeGuard.blocking) {
    const reuseHold = (activeGuard.other_active_holds && activeGuard.other_active_holds[0])
      || (activeGuard.matches && activeGuard.matches[0]);
    // Only reuse a hold if dates AND guest count match exactly — avoids reusing stale holds
    // from previous test runs or different conversations for the same phone number.
    const datesMatch = reuseHold
      && trimStr(reuseHold.check_in).slice(0, 10) === trimStr(fields.check_in).slice(0, 10)
      && trimStr(reuseHold.check_out).slice(0, 10) === trimStr(fields.check_out).slice(0, 10)
      && Number(reuseHold.guest_count) === Number(fields.guest_count);
    if (reuseHold && reuseHold.booking_id && datesMatch) {
      let payment = await loadPaymentDraftForBooking(pg, reuseHold.booking_id, clientRes.client_id);
      if (!payment) {
        payment = await ensurePaymentDraftOnBooking(pg, {
          clientId: clientRes.client_id,
          bookingId: reuseHold.booking_id,
          planner,
          paymentIdemKey,
          idempotencyKey,
        });
      }
      return { reused: { booking: reuseHold, payment } };
    }
    // Dates/guests don't match — do NOT reuse; fall through to create a fresh hold.
    // selectActiveHoldGuard is advisory; upsertBookingHold will resolve the conflict.
  }

  const holdExpiresAt = proposeGuestHoldExpiresAt();
  const wouldUpsert = {
    guest_name: guestName,
    phone: guestPhone,
    email: guestEmail,
    check_in: holdInput.check_in,
    check_out: holdInput.check_out,
    guest_count: holdInput.guest_count,
    requested_room_type: holdInput.room_type,
    room_preference: holdInput.room_preference,
    guest_gender_group_type: holdInput.guest_gender_group_type,
    primary_room_code: holdInput.primary_room_code,
    package_code: holdInput.package_code,
    hold_expires_at: holdExpiresAt,
  };

  const quoteSnapshot = {
    quote_total_cents: quote.quote_total_cents,
    deposit_options: quote.deposit_options || null,
    quote_status: quote.quote_status,
    payment_kind: planner.payment_kind,
    source: 'runBookingPreviewDryRun',
    captured_at: new Date().toISOString(),
  };

  const holdMeta = {
    source: WRITE_SOURCE,
    stage: '27n_guest_simulator',
    write_source: trimStr(ctx.source) || 'luna_guest_hold_payment_draft',
    idempotency_key: idempotencyKey,
    payment_kind: planner.payment_kind,
    payment_choice: chain.payment_choice?.payment_choice || planner.payment_kind,
    quote_snapshot_ref: {
      quote_total_cents: quote.quote_total_cents,
      quote_status: quote.quote_status,
      payment_kind: planner.payment_kind,
    },
    guest: {
      name: guestName,
      phone: guestPhone,
      email: guestEmail,
    },
  };

  await pg.query('BEGIN');
  try {
    const holdOutcome = await upsertBookingHold(pg, clientRes.client_id, holdInput, {
      ...wouldUpsert,
      metadata: holdMeta,
    });

    const bookingId = holdOutcome.booking.booking_id;
    const depositCents = quote.deposit_options?.deposit_required_cents ?? planner.payment_amount_cents;
    const totalCents = quote.quote_total_cents;
    const balanceCents = planner.balance_due_after_payment_cents;

    await pg.query(
      `UPDATE bookings
          SET total_amount_cents = $1,
              deposit_required_cents = $2,
              balance_due_cents = $3,
              payment_status = 'waiting_payment'::payment_status,
              metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
        WHERE id = $5::uuid`,
      [
        totalCents,
        depositCents,
        balanceCents,
        JSON.stringify({
          idempotency_key: idempotencyKey,
          quote_snapshot: quoteSnapshot,
          guest_intake_stage: 'hold_payment_draft_ready',
          guest: {
            name: guestName,
            phone: guestPhone,
            email: guestEmail,
          },
        }),
        bookingId,
      ],
    );

    const payKind = mapPaymentKind(planner.payment_kind);
    const pmMeta = {
      source: WRITE_SOURCE,
      idempotency_key: paymentIdemKey,
      guest_intake_idempotency_key: idempotencyKey,
      payment_choice: planner.payment_kind,
      is_payment_truth: false,
      stage: '27n',
    };

    const payIns = await pg.query(
      `INSERT INTO payments (
         client_id, booking_id, status, payment_kind, currency,
         amount_due_cents, amount_paid_cents, metadata
       ) VALUES (
         $1, $2::uuid, 'draft'::payment_record_status, $3::payment_kind, 'EUR',
         $4, 0, $5::jsonb
       ) RETURNING id::text AS payment_draft_id, amount_due_cents`,
      [
        clientRes.client_id,
        bookingId,
        payKind,
        planner.payment_amount_cents,
        JSON.stringify(pmMeta),
      ],
    );

    await pg.query('COMMIT');

    const bookingRow = {
      ...holdOutcome.booking,
      check_in: holdInput.check_in,
      check_out: holdInput.check_out,
      guest_count: holdInput.guest_count,
      package_code: holdInput.package_code,
    };

    const attach = await attachAllGuestAddonServices(pg, {
      clientSlug,
      bookingId,
      bookingCode: holdOutcome.booking.booking_code,
      guestName,
      extractedFields: attachFields,
      resultContext: chain.result,
      quote,
      clientId: clientRes.client_id,
      writeSource: WRITE_SOURCE,
    });

    const transferAttach = await attachGuestBookingTransfers(pg, {
      clientSlug,
      bookingId,
      booking: bookingRow,
      fields: attachFields,
    });

    return {
      created: true,
      booking_id: bookingId,
      booking_code: holdOutcome.booking.booking_code,
      payment_draft_id: payIns.rows[0].payment_draft_id,
      hold_expires_at: holdExpiresAt,
      hold_created: holdOutcome.created,
      hold_updated: holdOutcome.updated,
      ...attach,
      ...transferAttach,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { error: err.message || 'write_failed', handoff: false };
  }
}

/**
 * Stage 27n gated hold + payment draft write.
 *
 * @param {object} chainResult - { result, availability, quote, payment_choice }
 * @param {object} [context] - { confirm_write, client_slug, guest_name, guest_email, guest_phone, env, pg, planner }
 */
async function runGuestHoldPaymentDraftWriteDryRunApproved(chainResult, context) {
  const ctx = context || {};
  const lang = resolveLang(chainResult);

  const allow = shouldAllowGuestHoldPaymentDraftWrite(chainResult, ctx);
  if (!allow.allowed) {
    return buildWriteBlockedResponse(chainResult, ctx, allow.reasons, 'blocked');
  }

  const planner = ctx.planner || runGuestHoldPaymentDraftPlannerDryRun(chainResult, ctx);

  if (planner.plan_status !== 'ready'
    || planner.would_create_hold !== true
    || planner.would_create_payment_draft !== true
    || planner.would_create_stripe_link !== false) {
    return buildWriteNotReadyResponse(chainResult, planner, ['planner_not_ready_for_write']);
  }

  if (planner.plan_handoff_required === true) {
    return buildWriteNotReadyResponse(chainResult, planner, planner.plan_handoff_reasons || ['plan_handoff_required']);
  }

  const runWrite = async (pg) => {
    const outcome = await executeHoldPaymentDraftWrite(pg, chainResult, planner, ctx);
    if (outcome.reused) {
      return formatReuseResponse(chainResult, planner, outcome.reused, outcome);
    }
    if (outcome.error) {
      return {
        success: false,
        ...WRITE_SAFETY,
        write_attempted: true,
        write_status: outcome.handoff ? 'needs_staff_review' : 'error',
        planner,
        booking_id: null,
        booking_code: null,
        payment_draft_id: null,
        hold_expires_at: null,
        created_records: null,
        reused_records: null,
        write_block_reasons: [outcome.error],
        next_safe_step: outcome.handoff ? 'staff_handoff_required' : 'keep_dry_run',
        proposed_luna_reply: buildReply(lang, outcome.handoff ? 'handoff' : 'error'),
      };
    }

    return {
      success: true,
      ...WRITE_SAFETY,
      write_attempted: true,
      write_status: 'created',
      planner,
      booking_id: outcome.booking_id,
      booking_code: outcome.booking_code,
      payment_draft_id: outcome.payment_draft_id,
      hold_expires_at: outcome.hold_expires_at,
      attached_manual_services: outcome.attached_manual_services || [],
      created_records: {
        booking_hold: {
          booking_id: outcome.booking_id,
          booking_code: outcome.booking_code,
          hold_expires_at: outcome.hold_expires_at,
          status: EXECUTE_HOLD_STATUSES.status,
        },
        quote_snapshot: planner.planned_records?.quote_snapshot || null,
        payment_draft: {
          payment_draft_id: outcome.payment_draft_id,
          payment_kind: planner.payment_kind,
          amount_cents: planner.payment_amount_cents,
          status: 'draft',
        },
      },
      reused_records: null,
      write_block_reasons: [],
      next_safe_step: 'ready_for_stripe_test_link',
      proposed_luna_reply: buildReply(lang, 'ready'),
    };
  };

  if (ctx.pg && typeof ctx.pg.query === 'function') {
    return runWrite(ctx.pg);
  }

  try {
    return await withPgClient(runWrite);
  } catch (err) {
    return {
      success: false,
      ...WRITE_SAFETY,
      write_attempted: false,
      write_status: 'error',
      planner,
      booking_id: null,
      booking_code: null,
      payment_draft_id: null,
      hold_expires_at: null,
      created_records: null,
      reused_records: null,
      write_block_reasons: ['database_unavailable', err.message || 'pg_error'],
      next_safe_step: 'keep_dry_run',
      proposed_luna_reply: buildReply(lang, 'error'),
    };
  }
}

module.exports = {
  runGuestHoldPaymentDraftWriteDryRunApproved,
  shouldAllowGuestHoldPaymentDraftWrite,
  isGuestHoldPaymentDraftWriteEnvironment,
  confirmWriteApproved,
  lookupExistingHoldPaymentDraft,
  deriveBookingCode,
  syntheticGuestEmailFromPhone,
  mapPaymentKind,
  HOLD_EXPIRES_IN_HOURS,
  VALID_WRITE_STATUSES,
  WRITE_SAFETY,
  WRITE_SOURCE,
};
