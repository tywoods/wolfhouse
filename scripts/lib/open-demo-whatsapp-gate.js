'use strict';

/**
 * Stage 27demo-b/c/d — Open demo WhatsApp inbound gate + live reply + booking write gates.
 */

const OPEN_DEMO_WHATSAPP_ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

function trimEnv(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isProductionEnvironment(env) {
  const e = env || process.env;
  return String(e.NODE_ENV || '').toLowerCase() === 'production';
}

function isOpenDemoWhatsAppEnabled(env) {
  const e = env || process.env;
  return e.OPEN_DEMO_WHATSAPP_ENABLED === 'true';
}

function isOpenDemoLiveRepliesEnabled(env) {
  const e = env || process.env;
  return e.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true';
}

function isWhatsappDryRun(env) {
  const e = env || process.env;
  return trimEnv(e.WHATSAPP_DRY_RUN).toLowerCase() !== 'false';
}

function configuredDemoPhoneNumberId(env) {
  const e = env || process.env;
  const v = e.OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID;
  return v != null && trimEnv(v) ? trimEnv(v) : null;
}

function configuredWhatsappPhoneNumberId(env) {
  const e = env || process.env;
  const v = e.WHATSAPP_PHONE_NUMBER_ID;
  return v != null && trimEnv(v) ? trimEnv(v) : null;
}

function wantsSendLiveReplyConfirmed(body) {
  const b = body || {};
  return b.send_live_reply_confirmed === true || b.send_live_reply_confirmed === 'true';
}

/**
 * @returns {{ ok: boolean, status?: number, error?: string, code?: string }}
 */
function evaluateOpenDemoWhatsAppGate(body, env) {
  if (isProductionEnvironment(env)) {
    return {
      ok: false,
      status: 403,
      code: 'production_blocked',
      error: 'open demo WhatsApp inbound is disabled in production',
    };
  }
  if (!isOpenDemoWhatsAppEnabled(env)) {
    return {
      ok: false,
      status: 403,
      code: 'demo_disabled',
      error: 'open demo WhatsApp inbound is disabled (set OPEN_DEMO_WHATSAPP_ENABLED=true on staging)',
    };
  }
  const expectedPhoneNumberId = configuredDemoPhoneNumberId(env);
  if (expectedPhoneNumberId) {
    const incoming = body && body.phone_number_id != null
      ? trimEnv(body.phone_number_id)
      : '';
    if (!incoming || incoming !== expectedPhoneNumberId) {
      return {
        ok: false,
        status: 403,
        code: 'phone_number_id_mismatch',
        error: 'phone_number_id does not match OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID',
      };
    }
  }
  return { ok: true };
}

/**
 * Live reply gate — requires inbound demo gate + explicit env + WHATSAPP_DRY_RUN=false.
 * @returns {{ ok: boolean, status?: number, error?: string, code?: string }}
 */
function evaluateOpenDemoWhatsAppLiveReplyGate(body, env) {
  const inboundGate = evaluateOpenDemoWhatsAppGate(body, env);
  if (!inboundGate.ok) return inboundGate;

  if (isProductionEnvironment(env)) {
    return {
      ok: false,
      status: 403,
      code: 'production_blocked',
      error: 'open demo WhatsApp live replies are disabled in production',
    };
  }
  if (!isOpenDemoLiveRepliesEnabled(env)) {
    return {
      ok: false,
      status: 403,
      code: 'live_replies_disabled',
      error: 'open demo live replies disabled (set OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true)',
    };
  }
  if (isWhatsappDryRun(env)) {
    return {
      ok: false,
      status: 403,
      code: 'whatsapp_dry_run_active',
      error: 'WHATSAPP_DRY_RUN=true blocks live WhatsApp send',
    };
  }
  const demoPhoneId = configuredDemoPhoneNumberId(env);
  const waPhoneId = configuredWhatsappPhoneNumberId(env);
  if (demoPhoneId && waPhoneId && demoPhoneId !== waPhoneId) {
    return {
      ok: false,
      status: 403,
      code: 'whatsapp_phone_number_id_mismatch',
      error: 'WHATSAPP_PHONE_NUMBER_ID does not match OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID',
    };
  }
  return { ok: true };
}

function wantsCreateDemoHoldDraftConfirmed(body) {
  const b = body || {};
  return b.create_demo_hold_draft_confirmed === true
    || b.create_demo_hold_draft_confirmed === 'true';
}

function wantsAssignDemoBedConfirmed(body) {
  const b = body || {};
  return b.assign_demo_bed_confirmed === true
    || b.assign_demo_bed_confirmed === 'true';
}

function wantsCreateStripeTestLinkConfirmed(body) {
  const b = body || {};
  return b.create_stripe_test_link_confirmed === true
    || b.create_stripe_test_link_confirmed === 'true';
}

function wantsSendPaymentLinkWhatsAppConfirmed(body) {
  const b = body || {};
  return b.send_payment_link_whatsapp_confirmed === true
    || b.send_payment_link_whatsapp_confirmed === 'true';
}

function isOpenDemoStripeTestLinksEnabled(env) {
  const e = env || process.env;
  return e.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true';
}

function isStripeTestSecretKey(env) {
  const key = trimEnv((env || process.env).STRIPE_SECRET_KEY);
  return key.startsWith('sk_test_');
}

function isStripeLiveSecretKey(env) {
  const key = trimEnv((env || process.env).STRIPE_SECRET_KEY);
  return key.startsWith('sk_live_');
}

/**
 * Open demo Stripe TEST link gate — staging only, explicit env, test key required.
 * @returns {{ ok: boolean, status?: number, error?: string, code?: string }}
 */
function evaluateOpenDemoStripeTestLinkGate(body, env) {
  const inboundGate = evaluateOpenDemoWhatsAppGate(body, env);
  if (!inboundGate.ok) return inboundGate;

  const e = env || process.env;
  if (isProductionEnvironment(e)) {
    return {
      ok: false,
      status: 403,
      code: 'production_blocked',
      error: 'open demo Stripe test links are disabled in production',
    };
  }
  if (!isOpenDemoStripeTestLinksEnabled(e)) {
    return {
      ok: false,
      status: 403,
      code: 'stripe_test_links_disabled',
      error: 'open demo Stripe test links disabled (set OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=true)',
    };
  }
  if (!isOpenDemoBookingWritesEnabled(e)) {
    return {
      ok: false,
      status: 403,
      code: 'booking_writes_disabled',
      error: 'open demo Stripe test links require OPEN_DEMO_BOOKING_WRITES_ENABLED=true',
    };
  }
  if (e.STRIPE_LINKS_ENABLED !== 'true') {
    return {
      ok: false,
      status: 403,
      code: 'stripe_links_disabled',
      error: 'STRIPE_LINKS_ENABLED=true required for open demo Stripe test links',
    };
  }
  if (isStripeLiveSecretKey(e)) {
    return {
      ok: false,
      status: 403,
      code: 'stripe_live_key_blocked',
      error: 'sk_live_ keys are forbidden for open demo Stripe test links',
    };
  }
  if (!trimEnv(e.STRIPE_SECRET_KEY)) {
    return {
      ok: false,
      status: 403,
      code: 'stripe_secret_missing',
      error: 'STRIPE_SECRET_KEY is required',
    };
  }
  if (!isStripeTestSecretKey(e)) {
    return {
      ok: false,
      status: 403,
      code: 'stripe_test_mode_required',
      error: 'Stripe test mode (sk_test_) required for open demo links',
    };
  }
  if (e.STAFF_ACTIONS_ENABLED !== 'true') {
    return {
      ok: false,
      status: 403,
      code: 'staff_actions_disabled',
      error: 'STAFF_ACTIONS_ENABLED=true required for Stripe test link creation',
    };
  }
  return { ok: true };
}

function evaluateOpenDemoStripeLinkWriteReady(bookingWrite, body) {
  const bw = bookingWrite || {};
  const b = body || {};
  const draftId = trimEnv(bw.payment_draft_id) || trimEnv(b.payment_draft_id);
  const writeOk = bw.write_status === 'created' || bw.write_status === 'reused_existing';
  if (draftId && (writeOk || trimEnv(b.payment_draft_id))) {
    return {
      ok: true,
      payment_draft_id: draftId,
      booking_id: trimEnv(bw.booking_id) || trimEnv(b.booking_id) || null,
      booking_code: trimEnv(bw.booking_code) || trimEnv(b.booking_code) || null,
      next_safe_step: bw.next_safe_step || 'ready_for_stripe_test_link',
    };
  }
  return { ok: false, missing: ['payment_draft_not_ready'] };
}

async function resolveOpenDemoPaymentDraftRef(pg, clientSlug, guestPhone) {
  if (!pg || !trimEnv(clientSlug) || !trimEnv(guestPhone)) return null;
  const { rows } = await pg.query(
    `SELECT b.booking_code,
            b.id::text AS booking_id,
            p.id::text AS payment_draft_id,
            p.status::text AS payment_status,
            p.checkout_url
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
       INNER JOIN payments p ON p.booking_id = b.id
      WHERE c.slug = $1
        AND b.phone = $2
        AND p.status IN ('draft', 'checkout_created', 'pending')
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [clientSlug, guestPhone],
  );
  return rows[0] || null;
}

function buildOpenDemoPaymentLinkMessage(checkoutUrl) {
  const url = trimEnv(checkoutUrl);
  if (!url) return '';
  return `Perfect, here's the secure test payment link for your deposit: ${url}`;
}

function buildOpenDemoPaymentLinkSendBody(normalized, checkoutUrl) {
  const n = normalized || {};
  const message = buildOpenDemoPaymentLinkMessage(checkoutUrl);
  const idempotencyKey = `open-demo:${n.client_slug}:whatsapp:${n.inbound_message_id}:payment-link`;
  return {
    client_slug: n.client_slug,
    to: n.guest_phone,
    suggested_reply: message,
    send_kind: 'staff_reply',
    idempotency_key: idempotencyKey,
    source: 'open_demo_whatsapp_payment_link',
    draft: {
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      sends_whatsapp: false,
    },
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: true,
    },
  };
}

function formatOpenDemoStripeLinkResponse(linkOut) {
  const out = { ...(linkOut || {}) };
  out.confirmation_sent = false;
  out.payment_truth_applied = out.payment_truth_recorded === true;
  if (out.idempotent === true && out.stripe_link_created) {
    out.stripe_link_reused = true;
  } else if (out.stripe_link_created) {
    out.stripe_link_reused = false;
  }
  if (!out.stripe_mode) out.stripe_mode = 'test';
  if (!out.next_safe_step && out.stripe_checkout_url) {
    out.next_safe_step = 'awaiting_payment_truth';
  }
  return out;
}

function buildOpenDemoStripeLinkBlockedResponse(gateResult, extra) {
  const blocked = gateResult || {};
  return {
    create_stripe_test_link_confirmed: true,
    demo_stripe_link_blocked: true,
    demo_stripe_link_gate_code: blocked.code || 'blocked',
    demo_stripe_link_error: blocked.error || null,
    stripe_link_attempted: false,
    stripe_link_created: false,
    stripe_link_reused: false,
    stripe_mode: 'test',
    stripe_checkout_url: null,
    payment_link_sent: false,
    sends_whatsapp: false,
    whatsapp_sent: false,
    live_send_blocked: true,
    confirmation_sent: false,
    payment_truth_applied: false,
    ...(extra || {}),
  };
}

function buildOpenDemoPaymentLinkSendBlockedResponse(reasons, gateResult) {
  const blocked = gateResult || {};
  return {
    send_payment_link_whatsapp_confirmed: true,
    payment_link_send_attempted: true,
    payment_link_sent: false,
    sends_whatsapp: false,
    whatsapp_sent: false,
    live_send_blocked: true,
    payment_link_send_gate_blocked: true,
    payment_link_send_gate_code: blocked.code || 'blocked',
    payment_link_send_error: blocked.error || null,
    payment_link_send_block_reasons: reasons || [],
    confirmation_sent: false,
  };
}

function evaluateOpenDemoBedAssignmentWriteReady(bookingWrite) {
  const bw = bookingWrite || {};
  const ws = bw.write_status;
  if (ws !== 'created' && ws !== 'reused_existing') {
    return { ok: false, missing: ['booking_write_not_ready'] };
  }
  if (!bw.booking_id && !bw.booking_code) {
    return { ok: false, missing: ['missing_booking_reference'] };
  }
  return { ok: true, missing: [] };
}

function buildOpenDemoBedAssignmentBlockedResponse(reasons, gateResult) {
  const blocked = gateResult || {};
  return {
    demo_bed_assignment_blocked:      true,
    demo_bed_assignment_gate_code:    blocked.code || 'blocked',
    demo_bed_assignment_error:        blocked.error || null,
    assignment_write_attempted:       false,
    assignment_write_status:          'blocked',
    assignment_block_reasons:         reasons || [],
    calendar_visible_expected:        false,
    stripe_link_created:              false,
    payment_link_sent:                false,
    sends_whatsapp:                   false,
    live_send_blocked:                true,
  };
}

function isOpenDemoBookingWritesEnabled(env) {
  const e = env || process.env;
  return e.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true';
}

/**
 * Booking hold/draft write gate — staging open demo only; WHATSAPP_DRY_RUN does not block writes.
 * @returns {{ ok: boolean, status?: number, error?: string, code?: string }}
 */
function evaluateOpenDemoBookingWriteGate(body, env) {
  const inboundGate = evaluateOpenDemoWhatsAppGate(body, env);
  if (!inboundGate.ok) return inboundGate;

  if (isProductionEnvironment(env)) {
    return {
      ok: false,
      status: 403,
      code: 'production_blocked',
      error: 'open demo booking writes are disabled in production',
    };
  }
  if (!isOpenDemoBookingWritesEnabled(env)) {
    return {
      ok: false,
      status: 403,
      code: 'booking_writes_disabled',
      error: 'open demo booking writes disabled (set OPEN_DEMO_BOOKING_WRITES_ENABLED=true)',
    };
  }
  return { ok: true };
}

function evaluateOpenDemoHoldDraftWriteReady(review) {
  const r = review || {};
  const pc = r.payment_choice || {};
  const plan = r.hold_payment_draft_plan || {};
  const missing = [];
  if (pc.payment_choice_ready !== true) missing.push('payment_choice_not_ready');
  if (pc.next_safe_step !== 'ready_for_hold_payment_draft') {
    missing.push('next_safe_step_not_ready_for_hold_payment_draft');
  }
  if (plan.plan_status !== 'ready') missing.push('hold_payment_draft_plan_not_ready');
  return { ok: missing.length === 0, missing };
}

function buildOpenDemoWriteChainFromReview(review) {
  const r = review || {};
  return {
    result: r.result || {},
    availability: r.availability || {},
    quote: r.quote || {},
    payment_choice: r.payment_choice || {},
  };
}

function buildOpenDemoBookingWriteBlockedResponse(gateResult) {
  return {
    demo_booking_write_blocked:     true,
    demo_booking_write_gate_code:   gateResult.code || 'blocked',
    demo_booking_write_error:       gateResult.error || 'open demo booking write blocked',
    write_attempted:                false,
    write_status:                   'blocked',
    stripe_link_created:            false,
    payment_link_sent:              false,
    sends_whatsapp:                 false,
    live_send_blocked:              true,
  };
}

function buildOpenDemoLiveReplySendBody(normalized, proposedReply) {
  const n = normalized || {};
  const reply = trimEnv(proposedReply);
  const sendKind = 'staff_reply';
  const idempotencyKey = `open-demo:${n.client_slug}:whatsapp:${n.inbound_message_id}:live-reply`;
  return {
    client_slug: n.client_slug,
    to: n.guest_phone,
    suggested_reply: reply,
    send_kind: sendKind,
    idempotency_key: idempotencyKey,
    source: 'open_demo_whatsapp_live_reply',
    draft: {
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      sends_whatsapp: false,
    },
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: true,
    },
  };
}

function buildOpenDemoLiveReplyBlockedResponse(gateResult) {
  return {
    live_send_blocked:     true,
    sends_whatsapp:        false,
    whatsapp_sent:         false,
    send_performed:        false,
    live_reply_attempted:  false,
    live_reply_gate_blocked: true,
    live_reply_gate_code:  gateResult.code || 'blocked',
    live_reply_error:      gateResult.error || 'open demo live reply blocked',
  };
}

/** Dry-run payment-choice copy that must not be sent when staging writes are allowed. */
const OPEN_DEMO_PAYMENT_CHOICE_DEFERRED_DRY_RUN_RE =
  /I am not confirming the booking, creating a hold, or sending a payment link yet/i;

function formatOpenDemoPaymentAmountEur(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return null;
  const n = Number(cents);
  if (n % 100 === 0) return String(n / 100);
  return (n / 100).toFixed(2);
}

function resolveOpenDemoPaymentChoiceLang(review) {
  const r = review || {};
  return (r.result && r.result.detected_language) || 'en';
}

function resolveOpenDemoPaymentChoiceAmountCents(review) {
  const r = review || {};
  const plan = r.hold_payment_draft_plan || {};
  const quote = r.quote || {};
  if (plan.payment_amount_cents != null) return plan.payment_amount_cents;
  const dep = quote.deposit_options && quote.deposit_options.deposit_required_cents;
  if (dep != null) return dep;
  if (quote.quote_total_cents != null && (r.payment_choice || {}).payment_choice === 'full_payment') {
    return quote.quote_total_cents;
  }
  return null;
}

function isOpenDemoDepositPaymentChoice(review) {
  const r = review || {};
  const pc = (r.payment_choice || {}).payment_choice
    || (r.hold_payment_draft_plan || {}).payment_kind;
  return pc === 'deposit';
}

/**
 * Stage 28j.5 — defer dry-run payment-choice reply when live staging will run hold/draft writes.
 */
function shouldDeferOpenDemoPaymentChoiceReviewReply(body, env, review, flags) {
  const f = flags || {};
  if (f.send_live_reply_confirmed !== true || f.create_demo_hold_draft_confirmed !== true) {
    return false;
  }
  const writeGate = evaluateOpenDemoBookingWriteGate(body, env);
  if (!writeGate.ok) return false;
  return evaluateOpenDemoHoldDraftWriteReady(review || {}).ok === true;
}

/**
 * Stage 28j.5 — guest-facing reply after hold/draft (+ optional Stripe link) writes.
 */
function buildOpenDemoPaymentChoiceLiveReply(review, outcomes) {
  const r = review || {};
  const o = outcomes || {};
  const bw = o.bookingWrite || {};
  const plSend = o.paymentLinkSend || {};
  const lang = resolveOpenDemoPaymentChoiceLang(r);
  const writeOk = bw.write_status === 'created' || bw.write_status === 'reused_existing';
  const isDeposit = isOpenDemoDepositPaymentChoice(r);
  const amountEur = formatOpenDemoPaymentAmountEur(resolveOpenDemoPaymentChoiceAmountCents(r));
  const linkSent = plSend.payment_link_sent === true;

  const amountPhrase = amountEur
    ? (isDeposit ? `€${amountEur} deposit` : `€${amountEur}`)
    : (isDeposit ? 'deposit' : 'full amount');

  const byLang = {
    en: {
      hold_staff_sends: `Thanks! Your stay is held. Our team will send your secure payment link here shortly for your ${amountPhrase}.`,
      hold_link_sent: `Thanks! Your stay is held. I've sent your secure test payment link in a separate message for your ${amountPhrase}.`,
      write_pending: 'Thanks! I noted your payment preference. Our team will follow up with the next step shortly.',
    },
    it: {
      hold_staff_sends: `Grazie! Il soggiorno è in hold. Il team invierà a breve il link di pagamento sicuro per il ${amountPhrase}.`,
      hold_link_sent: `Grazie! Il soggiorno è in hold. Ho inviato il link di pagamento di test in un messaggio separato per il ${amountPhrase}.`,
      write_pending: 'Grazie! Ho annotato la preferenza di pagamento. Il team seguirà a breve.',
    },
    es: {
      hold_staff_sends: `¡Gracias! Tu estancia está en hold. El equipo enviará pronto el enlace de pago seguro para el ${amountPhrase}.`,
      hold_link_sent: `¡Gracias! Tu estancia está en hold. Envié el enlace de pago de prueba en un mensaje aparte para el ${amountPhrase}.`,
      write_pending: '¡Gracias! Anoté tu preferencia de pago. El equipo seguirá en breve.',
    },
    de: {
      hold_staff_sends: `Danke! Euer Aufenthalt ist reserviert. Das Team schickt gleich den sicheren Zahlungslink für die ${amountPhrase}.`,
      hold_link_sent: `Danke! Euer Aufenthalt ist reserviert. Den Test-Zahlungslink habe ich in einer separaten Nachricht für die ${amountPhrase} geschickt.`,
      write_pending: 'Danke! Ich habe eure Zahlungswahl notiert. Das Team meldet sich gleich.',
    },
    fr: {
      hold_staff_sends: `Merci ! Votre séjour est en attente. L'équipe enverra bientôt le lien de paiement sécurisé pour l'${amountPhrase}.`,
      hold_link_sent: `Merci ! Votre séjour est en attente. J'ai envoyé le lien de paiement test dans un message séparé pour l'${amountPhrase}.`,
      write_pending: 'Merci ! J\'ai noté votre choix de paiement. L\'équipe suivra sous peu.',
    },
  };
  const L = byLang[lang] || byLang.en;
  if (!writeOk) return L.write_pending;
  return linkSent ? L.hold_link_sent : L.hold_staff_sends;
}

function resolveInboundMessageId(body) {
  const b = body || {};
  if (b.inbound_message_id != null && String(b.inbound_message_id).trim()) {
    return String(b.inbound_message_id).trim();
  }
  if (b.wamid != null && String(b.wamid).trim()) {
    return String(b.wamid).trim();
  }
  if (b.raw_meta_message_id != null && String(b.raw_meta_message_id).trim()) {
    return String(b.raw_meta_message_id).trim();
  }
  return null;
}

/**
 * Validate n8n-shaped open demo payload (after trim).
 */
function validateOpenDemoInboundBody(body) {
  const b = body || {};
  const clientSlug = b.client_slug != null ? String(b.client_slug).trim() : '';
  const channel = b.channel != null ? String(b.channel).trim().toLowerCase() : '';
  const guestPhone = b.guest_phone != null ? String(b.guest_phone).trim() : '';
  const messageText = b.message_text != null ? String(b.message_text).trim() : '';
  const inboundMessageId = resolveInboundMessageId(b);

  const missing = [];
  if (!clientSlug) missing.push('client_slug');
  if (channel !== 'whatsapp') missing.push('channel must be whatsapp');
  if (!guestPhone) missing.push('guest_phone');
  if (!messageText) missing.push('message_text');
  if (!inboundMessageId) missing.push('inbound_message_id or wamid');

  return {
    ok: missing.length === 0,
    missing,
    normalized: {
      source: 'n8n_open_demo_whatsapp',
      client_slug: clientSlug,
      channel: 'whatsapp',
      guest_phone: guestPhone,
      message_text: messageText,
      inbound_message_id: inboundMessageId,
      phone_number_id: b.phone_number_id != null ? String(b.phone_number_id).trim() : null,
      contact_name: b.contact_name != null ? String(b.contact_name).trim() : null,
      received_at: b.received_at != null ? String(b.received_at).trim() : null,
      reference_date: b.reference_date != null ? String(b.reference_date).trim() : null,
      language_hint: b.language_hint,
      guest_context: b.guest_context,
      conversation_id: b.conversation_id != null ? String(b.conversation_id).trim() : null,
      automation_gate_context: {
        ...(b.automation_gate_context && typeof b.automation_gate_context === 'object'
          ? b.automation_gate_context
          : {}),
        public_guest_automation_enabled: false,
        whatsapp_dry_run: true,
        live_send_allowed: false,
        open_demo_whatsapp: true,
      },
    },
  };
}

function buildOpenDemoBlockedResponse(gateResult) {
  return {
    success:           false,
    dry_run:           true,
    open_demo:         true,
    sends_whatsapp:    false,
    live_send_blocked: true,
    demo_gate_blocked: true,
    demo_gate_code:    gateResult.code || 'blocked',
    error:             gateResult.error || 'open demo inbound blocked',
  };
}

module.exports = {
  OPEN_DEMO_WHATSAPP_ROUTE,
  isProductionEnvironment,
  isOpenDemoWhatsAppEnabled,
  isOpenDemoLiveRepliesEnabled,
  isOpenDemoBookingWritesEnabled,
  isWhatsappDryRun,
  configuredDemoPhoneNumberId,
  configuredWhatsappPhoneNumberId,
  wantsSendLiveReplyConfirmed,
  wantsCreateDemoHoldDraftConfirmed,
  wantsAssignDemoBedConfirmed,
  wantsCreateStripeTestLinkConfirmed,
  wantsSendPaymentLinkWhatsAppConfirmed,
  isOpenDemoStripeTestLinksEnabled,
  isStripeTestSecretKey,
  isStripeLiveSecretKey,
  evaluateOpenDemoStripeTestLinkGate,
  evaluateOpenDemoStripeLinkWriteReady,
  resolveOpenDemoPaymentDraftRef,
  buildOpenDemoPaymentLinkMessage,
  buildOpenDemoPaymentLinkSendBody,
  formatOpenDemoStripeLinkResponse,
  buildOpenDemoStripeLinkBlockedResponse,
  buildOpenDemoPaymentLinkSendBlockedResponse,
  evaluateOpenDemoWhatsAppGate,
  evaluateOpenDemoWhatsAppLiveReplyGate,
  evaluateOpenDemoBookingWriteGate,
  evaluateOpenDemoHoldDraftWriteReady,
  evaluateOpenDemoBedAssignmentWriteReady,
  buildOpenDemoWriteChainFromReview,
  buildOpenDemoLiveReplySendBody,
  buildOpenDemoLiveReplyBlockedResponse,
  OPEN_DEMO_PAYMENT_CHOICE_DEFERRED_DRY_RUN_RE,
  shouldDeferOpenDemoPaymentChoiceReviewReply,
  buildOpenDemoPaymentChoiceLiveReply,
  buildOpenDemoBookingWriteBlockedResponse,
  buildOpenDemoBedAssignmentBlockedResponse,
  resolveInboundMessageId,
  validateOpenDemoInboundBody,
  buildOpenDemoBlockedResponse,
};
