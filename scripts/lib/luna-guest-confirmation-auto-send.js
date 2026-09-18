'use strict';

/**
 * Stage 54 — Auto-send booking confirmation WhatsApp after payment truth.
 * No per-phone allowlist — gated only by LUNA_AUTO_SEND_ENABLED + WHATSAPP_DRY_RUN.
 */

const { runGuestConfirmationPreviewDryRun } = require('./luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationSendGoNoGo, isWhatsappDryRun } = require('./luna-guest-confirmation-send-go-no-go');
const { mirrorHermesWhatsAppThreadMessage } = require('./luna-hermes-whatsapp-thread-mirror');
const { markBookingConfirmationSent } = require('./luna-booking-confirmation-send');

const PAID_BOOKING_STATUSES = new Set(['deposit_paid', 'paid']);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isAutoConfirmationSendEnabled(env) {
  const e = env || process.env;
  return String(e.LUNA_AUTO_SEND_ENABLED || '').trim().toLowerCase() === 'true';
}

function isAuthoritativeSunsetStaging(env, clientSlug) {
  const e = env || process.env;
  const nodeEnv = trimStr(e.NODE_ENV).toLowerCase();
  return trimStr(clientSlug) === 'sunset'
    && trimStr(e.DEFAULT_CLIENT_SLUG) === 'sunset'
    && trimStr(e.LUNA_DEPLOYMENT) === 'sunset-staging'
    && nodeEnv === 'staging';
}

async function loadVerifiedPaymentTruth(pg, bookingId, clientSlug) {
  const id = trimStr(bookingId);
  if (!id) return { verified: false, reason: 'missing_booking_id' };
  const r = await pg.query(
    `SELECT b.payment_status::text AS booking_payment_status,
            COALESCE(p.amount_paid_cents, 0)::bigint AS amount_paid_cents,
            p.status::text AS payment_record_status
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
       LEFT JOIN LATERAL (
         SELECT amount_paid_cents, status
           FROM payments
          WHERE booking_id = b.id AND client_id = b.client_id
          ORDER BY paid_at DESC NULLS LAST, created_at DESC
          LIMIT 1
       ) p ON true
      WHERE b.id = $1::uuid AND c.slug = $2
      LIMIT 1`,
    [id, trimStr(clientSlug)],
  );
  const row = r.rows[0];
  if (!row) return { verified: false, reason: 'booking_not_found' };
  const paidCents = Number(row.amount_paid_cents || 0);
  const recordPaid = trimStr(row.payment_record_status) === 'paid';
  if (paidCents > 0 || recordPaid) {
    return {
      verified: true,
      amount_paid_cents: paidCents,
      payment_record_status: row.payment_record_status,
      booking_payment_status: row.booking_payment_status,
    };
  }
  return {
    verified: false,
    reason: 'no_payment_record_truth',
    booking_payment_status: row.booking_payment_status,
    amount_paid_cents: paidCents,
    payment_record_status: row.payment_record_status,
  };
}

async function loadBookingSendState(pg, { bookingId, bookingCode, clientSlug }) {
  const id = trimStr(bookingId);
  const code = trimStr(bookingCode);
  if (!id && !code) return null;
  const q = id
    ? `SELECT b.id, b.booking_code, b.status::text AS booking_status,
              b.payment_status::text AS payment_status,
              b.confirmation_sent_at,
              b.metadata->'guest'->>'phone' AS guest_phone_meta,
              NULLIF(TRIM(b.phone), '') AS guest_phone_column,
              b.metadata->'guest'->>'name' AS guest_name_meta,
              b.guest_name
         FROM bookings b INNER JOIN clients c ON c.id = b.client_id
        WHERE b.id = $1::uuid AND c.slug = $2 LIMIT 1`
    : `SELECT b.id, b.booking_code, b.status::text AS booking_status,
              b.payment_status::text AS payment_status,
              b.confirmation_sent_at,
              b.metadata->'guest'->>'phone' AS guest_phone_meta,
              NULLIF(TRIM(b.phone), '') AS guest_phone_column,
              b.metadata->'guest'->>'name' AS guest_name_meta,
              b.guest_name
         FROM bookings b INNER JOIN clients c ON c.id = b.client_id
        WHERE b.booking_code = $1 AND c.slug = $2 LIMIT 1`;
  const r = await pg.query(q, [id || code, trimStr(clientSlug)]);
  return r.rows[0] || null;
}

async function loadCrowsnestSimulatorContext(pg, clientSlug, guestPhones) {
  const phones = [...new Set((Array.isArray(guestPhones) ? guestPhones : [guestPhones])
    .map(trimStr).filter(Boolean))];
  if (phones.length === 0) return null;
  const r = await pg.query(
    `SELECT conv.id::text AS conversation_id,
            conv.phone,
            conv.metadata->>'location_id' AS location_id,
            conv.metadata->>'simulator_source_phone' AS simulator_source_phone
       FROM conversations conv
       INNER JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1
        AND conv.phone = ANY($2::text[])
        AND conv.metadata->>'simulator_synthetic' = 'true'
        AND conv.metadata->>'source_owner' = 'crowsnest-guest-door'`,
    [clientSlug, phones],
  );
  const rows = Array.isArray(r.rows) ? r.rows : [];
  const conversationIds = [...new Set(rows.map((row) => trimStr(row.conversation_id)).filter(Boolean))];
  // Phone aliases are only safe when every trusted match converges on one
  // durable conversation. Never let query order choose between conversations.
  if (conversationIds.length !== 1) return null;
  const matches = rows.filter((row) => trimStr(row.conversation_id) === conversationIds[0]);
  const canonical = matches.find((row) => phones.includes(trimStr(row.phone)));
  if (!canonical || !trimStr(canonical.phone)) return null;
  return {
    ...canonical,
    conversation_id: conversationIds[0],
    phone: trimStr(canonical.phone),
    matched_booking_phones: [...new Set(matches.map((row) => trimStr(row.phone)).filter(Boolean))],
  };
}

/**
 * Attempt confirmation preview + live send when booking is paid and not yet confirmed.
 */
async function tryAutoSendBookingConfirmation(input, context) {
  const src = input || {};
  const ctx = context || {};
  const env = ctx.env || process.env;
  const pg = ctx.pg;

  const base = {
    attempted: false,
    skipped: true,
    skip_reason: null,
    preview: null,
    send: null,
    confirmation_sent: false,
  };

  if (!pg) {
    return { ...base, skip_reason: 'missing_pg' };
  }

  const bookingId = trimStr(src.booking_id);
  const bookingCode = trimStr(src.booking_code);
  let to = trimStr(src.to);
  const clientSlug = trimStr(src.client_slug) || 'wolfhouse-somo';

  let row;
  try {
    row = await loadBookingSendState(pg, { bookingId, bookingCode, clientSlug });
  } catch (err) {
    return { ...base, skip_reason: `db_error:${String(err.message || err).slice(0, 80)}` };
  }

  if (!row) return { ...base, skip_reason: 'booking_not_found' };
  if (row.confirmation_sent_at) {
    return { ...base, skip_reason: 'confirmation_already_sent', booking_code: row.booking_code };
  }
  if (!PAID_BOOKING_STATUSES.has(trimStr(row.payment_status))) {
    return {
      ...base,
      skip_reason: 'booking_not_paid_yet',
      payment_status: row.payment_status,
      booking_code: row.booking_code,
    };
  }

  const paymentTruth = await loadVerifiedPaymentTruth(pg, row.id, clientSlug);
  if (!paymentTruth.verified) {
    return {
      ...base,
      skip_reason: paymentTruth.reason || 'payment_record_not_paid',
      payment_status: row.payment_status,
      booking_code: row.booking_code,
      payment_truth: paymentTruth,
    };
  }

  if (!to) to = trimStr(row.guest_phone_meta) || trimStr(row.guest_phone_column);
  if (!to) return { ...base, skip_reason: 'missing_guest_phone', booking_code: row.booking_code };

  const sunsetStaging = isAuthoritativeSunsetStaging(env, clientSlug);
  // Public webhook projections are never identity authority. Resolve only from
  // the booking reloaded after payment commit, retaining each source as audit
  // provenance for the established conversation.
  const durableBookingPhones = [
    { source: 'booking_metadata_guest_phone', phone: trimStr(row.guest_phone_meta) },
    { source: 'booking_phone_column', phone: trimStr(row.guest_phone_column) },
  ].filter((identity) => identity.phone);
  const resolvedSimulator = sunsetStaging ? await loadCrowsnestSimulatorContext(
    pg,
    clientSlug,
    durableBookingPhones.map((identity) => identity.phone),
  ) : null;
  const simulator = resolvedSimulator ? {
    ...resolvedSimulator,
    matched_booking_identities: durableBookingPhones.filter(
      (identity) => resolvedSimulator.matched_booking_phones.includes(identity.phone),
    ),
  } : null;
  if (ctx.simulatorReconciliationOnly === true && !simulator) {
    return { ...base, skip_reason: 'not_trusted_sunset_simulator', booking_code: row.booking_code };
  }
  if (simulator) to = trimStr(simulator.phone) || to;
  if (simulator && !PAID_BOOKING_STATUSES.has(trimStr(row.payment_status).toLowerCase())) {
    return { ...base, skip_reason: 'booking_not_paid', booking_code: row.booking_code };
  }
  if (simulator && !['confirmed', 'payment_pending', 'checked_in'].includes(
    trimStr(row.booking_status).toLowerCase(),
  )) {
    return { ...base, skip_reason: 'booking_status_not_confirmation_eligible', booking_code: row.booking_code };
  }
  if (!simulator && !isAutoConfirmationSendEnabled(env)) {
    return { ...base, skip_reason: 'luna_auto_send_not_enabled' };
  }

  const previewConfirmation = ctx.runGuestConfirmationPreviewDryRun || runGuestConfirmationPreviewDryRun;
  const preview = await previewConfirmation({
    client_slug: clientSlug,
    booking_id: row.id,
    booking_code: row.booking_code,
    payment_status: row.payment_status,
    guest_name: trimStr(src.guest_name) || trimStr(row.guest_name_meta) || null,
    language_hint: trimStr(src.language_hint) || 'en',
  }, {
    pg,
    env,
    // Established from authoritative deployment scope + durable Crows Nest
    // conversation ownership above, never from public preview input.
    trusted_crowsnest_sunset_course: !!simulator,
  });

  if (!preview || preview.confirmation_preview_ready !== true) {
    return {
      ...base,
      attempted: true,
      skip_reason: 'preview_not_ready',
      preview,
      booking_code: row.booking_code,
      block_reasons: preview && preview.block_reasons,
    };
  }

  const idempotencyKey = trimStr(src.idempotency_key)
    || `confirmation:auto:${row.booking_code}:${row.id}`;

  if (simulator) {
    const persistMirror = ctx.mirrorHermesWhatsAppThreadMessage || mirrorHermesWhatsAppThreadMessage;
    const mirrored = await persistMirror(pg, {
      client_slug: clientSlug,
      guest_phone: to,
      direction: 'outbound',
      message_text: preview.message_preview,
      idempotency_key: idempotencyKey,
      location_id: simulator.location_id || null,
      simulator_synthetic: true,
      source_owner: 'crowsnest-guest-door',
      simulator_source_phone: simulator.simulator_source_phone || null,
      suppress_notifications: true,
      suppress_approvals: true,
    }, { env });
    const persisted = !!(mirrored && mirrored.ok === true && mirrored.thread
      && (mirrored.thread.persisted === true || mirrored.thread.duplicate === true));
    if (!persisted) {
      return {
        ...base,
        attempted: true,
        skip_reason: 'synthetic_inbox_persist_failed',
        preview,
        booking_code: row.booking_code,
        synthetic_inbox: mirrored,
        whatsapp_suppressed: true,
      };
    }
    const markSent = ctx.markBookingConfirmationSent || markBookingConfirmationSent;
    const marked = await markSent(pg, {
      client_slug: clientSlug,
      booking_id: row.id,
      guest_message_send_id: idempotencyKey,
      provider_message_id: null,
      confirmation_sent_source: 'crowsnest_simulator_staff_inbox',
      confirmation_sent_via: 'staff_inbox_simulator',
    });
    return {
      attempted: true,
      skipped: false,
      skip_reason: null,
      preview,
      send: null,
      confirmation_sent: !!(marked && (marked.updated || marked.already_sent)),
      confirmation_sent_at: marked && marked.confirmation_sent_at,
      booking_code: row.booking_code,
      synthetic_inbox: mirrored,
      synthetic_inbox_persisted: true,
      whatsapp_suppressed: true,
      whatsapp_dry_run: true,
    };
  }

  const send = await runGuestConfirmationSendGoNoGo({
    confirmation_preview_result: preview,
    confirm_send: true,
    to,
    idempotency_key: idempotencyKey,
    client_slug: clientSlug,
    booking_id: row.id,
    booking_code: row.booking_code,
  }, {
    pg,
    env,
    sendLunaBookingConfirmation: ctx.sendLunaBookingConfirmation,
    evaluateGuestReplySendRouteWithPause: ctx.evaluateGuestReplySendRouteWithPause,
    sendMessage: ctx.sendMessage,
    fetch: ctx.fetch,
    loadClientConfirmationConfig: ctx.loadClientConfirmationConfig,
  });

  const sent = send && (send.confirmation_sent === true || send.send_status === 'sent');
  return {
    attempted: true,
    skipped: !sent,
    skip_reason: sent ? null : (send && send.send_status) || 'send_blocked',
    preview,
    send,
    confirmation_sent: sent,
    booking_code: row.booking_code,
    whatsapp_dry_run: isWhatsappDryRun(env),
  };
}

module.exports = {
  PAID_BOOKING_STATUSES,
  isAutoConfirmationSendEnabled,
  isAuthoritativeSunsetStaging,
  tryAutoSendBookingConfirmation,
  loadBookingSendState,
  loadVerifiedPaymentTruth,
  loadCrowsnestSimulatorContext,
};
