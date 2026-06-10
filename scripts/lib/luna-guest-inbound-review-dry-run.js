'use strict';

/**
 * Stage 27x.1 — Inbound guest review dry-run (n8n-shaped payload → 27u orchestrator).
 * Review-only: no WhatsApp send, no booking/hold/payment writes, no Stripe.
 *
 * @module luna-guest-inbound-review-dry-run
 */

const { runGuestAutomationOrchestratorDryRun } = require('./luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./luna-guest-context-merge');
const { getPauseState } = require('./staff-bot-pause-sql');

const INBOUND_REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function ensureInboundMessageId(body) {
  const existing = body && body.inbound_message_id != null
    ? trimStr(body.inbound_message_id)
    : '';
  if (existing) return existing;
  return `local-harness-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildInboundReviewIdempotencyKey(body) {
  const clientSlug = trimStr(body.client_slug);
  const channel = trimStr(body.channel);
  const inboundMessageId = ensureInboundMessageId(body);
  const explicit = body.idempotency_key != null ? trimStr(body.idempotency_key) : '';
  if (explicit) return explicit;
  return `${clientSlug}:${channel}:${inboundMessageId}`;
}

function validateInboundReviewBody(body) {
  const src = body || {};
  const clientSlug = trimStr(src.client_slug);
  const channel = trimStr(src.channel);
  const guestPhone = trimStr(src.guest_phone);
  const messageText = trimStr(src.message_text);
  const inboundMessageId = ensureInboundMessageId(src);

  const missing = [];
  if (!clientSlug) missing.push('client_slug');
  if (!channel) missing.push('channel');
  if (!guestPhone) missing.push('guest_phone');
  if (!messageText) missing.push('message_text');

  return {
    ok: missing.length === 0,
    missing,
    normalized: {
      client_slug: clientSlug,
      channel,
      guest_phone: guestPhone,
      message_text: messageText,
      inbound_message_id: inboundMessageId,
      conversation_id: src.conversation_id != null ? trimStr(src.conversation_id) || null : null,
      idempotency_key: buildInboundReviewIdempotencyKey({ ...src, inbound_message_id: inboundMessageId }),
      received_at: src.received_at != null ? trimStr(src.received_at) || null : null,
      reference_date: src.reference_date != null ? trimStr(src.reference_date) || null : null,
      language_hint: src.language_hint,
      guest_context: src.guest_context,
      guest_name: trimStr(src.guest_name || src.contact_name) || null,
      contact_name: trimStr(src.contact_name || src.guest_name) || null,
      automation_gate_context: src.automation_gate_context,
    },
  };
}

function collectGuestAutomationReviewHandoffReasons(orchOut) {
  const reasons = [];
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const r of arr) {
      if (r != null && trimStr(r)) reasons.push(trimStr(r));
    }
  };
  if (orchOut && orchOut.automation_gate) push(orchOut.automation_gate.gate_reasons);
  if (orchOut && orchOut.result) {
    push(orchOut.result.handoff_reasons);
    if (orchOut.result.safe_handoff_required) reasons.push('staff_handoff_required');
  }
  if (orchOut && orchOut.availability) push(orchOut.availability.availability_handoff_reasons);
  if (orchOut && orchOut.quote) push(orchOut.quote.quote_handoff_reasons);
  if (orchOut && orchOut.payment_choice) push(orchOut.payment_choice.payment_choice_reasons);
  if (orchOut && orchOut.hold_payment_draft_plan) {
    push(orchOut.hold_payment_draft_plan.plan_handoff_reasons);
  }
  return [...new Set(reasons)];
}

function buildReviewFromOrchestrator(orchOut) {
  return {
    automation_gate:         orchOut.automation_gate,
    proposed_next_action:    orchOut.proposed_next_action,
    proposed_luna_reply:     orchOut.proposed_luna_reply,
    result:                  orchOut.result,
    availability:            orchOut.availability,
    quote:                   orchOut.quote,
    payment_choice:          orchOut.payment_choice,
    hold_payment_draft_plan: orchOut.hold_payment_draft_plan,
    handoff_reasons:         collectGuestAutomationReviewHandoffReasons(orchOut),
  };
}

function slimResultForChain(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    message_lane: result.message_lane,
    intake_state: result.intake_state,
    readiness_state: result.readiness_state,
    booking_intake_ready: result.booking_intake_ready,
    extracted_fields: result.extracted_fields,
    detected_language: result.detected_language,
    package_night_rule: result.package_night_rule,
    conversation_brain: result.conversation_brain,
  };
}

function slimAvailabilityForChain(availability) {
  if (!availability || typeof availability !== 'object') return availability;
  return {
    availability_check_attempted: availability.availability_check_attempted,
    availability_status: availability.availability_status,
  };
}

function slimQuoteForChain(quote) {
  if (!quote || typeof quote !== 'object') return quote;
  const slim = {
    quote_status: quote.quote_status,
    quote_total_cents: quote.quote_total_cents,
    payment_choice_needed: quote.payment_choice_needed,
  };
  if (quote.deposit_options) {
    slim.deposit_options = {
      deposit_required_cents: quote.deposit_options.deposit_required_cents,
      full_payment_cents: quote.deposit_options.full_payment_cents,
    };
  }
  return slim;
}

function slimPaymentChoiceForChain(paymentChoice) {
  if (!paymentChoice || typeof paymentChoice !== 'object') return paymentChoice;
  return {
    payment_choice_detected: paymentChoice.payment_choice_detected,
    payment_choice: paymentChoice.payment_choice,
    payment_choice_ready: paymentChoice.payment_choice_ready,
    next_safe_step: paymentChoice.next_safe_step,
  };
}

function slimGuestContextForNextTurn(review) {
  const r = review || {};
  const ctx = {
    message_lane: r.result && r.result.message_lane,
    intake_state: r.result && r.result.intake_state,
    readiness_state: r.result && r.result.readiness_state,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    extracted_fields: r.result && r.result.extracted_fields,
    result: slimResultForChain(r.result),
    availability: slimAvailabilityForChain(r.availability),
    quote: slimQuoteForChain(r.quote),
    payment_choice_needed: r.quote && r.quote.payment_choice_needed,
    payment_choice: slimPaymentChoiceForChain(r.payment_choice),
    detected_language: r.result && r.result.detected_language,
    last_updated_at: new Date().toISOString(),
  };
  return normalizeGuestContextForChain(ctx);
}

function guestContextFromReviewBody(review) {
  return slimGuestContextForNextTurn(review);
}

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function getCachedInboundReview(metadata, idempotencyKey) {
  const meta = metadata || {};
  const reviews = meta.luna_inbound_reviews && typeof meta.luna_inbound_reviews === 'object'
    ? meta.luna_inbound_reviews
    : {};
  const cached = reviews[idempotencyKey];
  if (!cached || typeof cached !== 'object') return null;
  if (!cached.review || typeof cached.review !== 'object') return null;
  return cached;
}

async function resolveClientId(pg, clientSlug) {
  const r = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  return r.rows[0] ? r.rows[0].id : null;
}

async function loadConversationRow(pg, { clientId, conversationId, guestPhone }) {
  if (conversationId) {
    const r = await pg.query(
      `SELECT id::text AS conversation_id, phone, needs_human, metadata, staff_reply_draft
         FROM conversations
        WHERE id = $1::uuid AND client_id = $2
        LIMIT 1`,
      [conversationId, clientId],
    );
    return r.rows[0] || null;
  }
  if (guestPhone) {
    const r = await pg.query(
      `SELECT id::text AS conversation_id, phone, needs_human, metadata, staff_reply_draft
         FROM conversations
        WHERE client_id = $1 AND phone = $2
        LIMIT 1`,
      [clientId, guestPhone],
    );
    return r.rows[0] || null;
  }
  return null;
}

async function buildAutomationGateContext(pg, normalized, convRow) {
  const reqGate = normalized.automation_gate_context && typeof normalized.automation_gate_context === 'object'
    ? normalized.automation_gate_context
    : {};

  let botPaused = reqGate.bot_paused === true;
  let humanTakeover = reqGate.human_takeover === true;

  if (convRow && convRow.needs_human === true) humanTakeover = true;

  try {
    const pause = await getPauseState(pg, {
      client_slug:     normalized.client_slug,
      conversation_id: convRow && convRow.conversation_id,
      guest_phone:     normalized.guest_phone,
    });
    if (pause.row && pause.row.paused === true) botPaused = true;
  } catch (_) {
    /* non-fatal — gate context falls back to request flags */
  }

  return {
    ...reqGate,
    public_guest_automation_enabled: false,
    whatsapp_dry_run:                true,
    live_send_allowed:               false,
    bot_paused:                      botPaused,
    human_takeover:                  humanTakeover,
  };
}

function mergeGuestContext(storedContext, requestContext) {
  const stored = storedContext && typeof storedContext === 'object' ? storedContext : null;
  const requested = requestContext && typeof requestContext === 'object' ? requestContext : null;
  if (requested) return normalizeGuestContextForChain(requested);
  if (stored) return normalizeGuestContextForChain(stored);
  return {};
}

function buildInboundReviewResponse({
  orchOut,
  normalized,
  conversationId,
  idempotentReplay,
  reviewPersistencePerformed,
}) {
  const review = buildReviewFromOrchestrator(orchOut);
  const slimGuestContext = slimGuestContextForNextTurn(review);

  return {
    success:                      orchOut.success !== false,
    dry_run:                      true,
    sends_whatsapp:               false,
    live_send_blocked:            true,
    no_write_performed:           true,
    public_guest_automation_enabled: false,
    whatsapp_dry_run:             true,
    review,
    slim_guest_context_for_next_turn: slimGuestContext,
    conversation_id:              conversationId || null,
    inbound_message_id:           normalized.inbound_message_id,
    idempotency_key:              normalized.idempotency_key,
    idempotent_replay:            idempotentReplay === true,
    review_persistence_performed:   reviewPersistencePerformed === true,
  };
}

async function persistInboundReviewArtifact(pg, {
  clientId,
  normalized,
  convRow,
  review,
  slimGuestContext,
}) {
  let row = convRow;
  if (!row) {
    row = await loadConversationRow(pg, {
      clientId,
      guestPhone: normalized.guest_phone,
    });
  }

  const preview = normalized.message_text.length > 200
    ? `${normalized.message_text.slice(0, 197)}...`
    : normalized.message_text;
  const proposedReply = review.proposed_luna_reply != null
    ? String(review.proposed_luna_reply)
    : null;

  const existingMeta = row ? parseMetadata(row.metadata) : {};
  const inboundReviews = existingMeta.luna_inbound_reviews && typeof existingMeta.luna_inbound_reviews === 'object'
    ? { ...existingMeta.luna_inbound_reviews }
    : {};

  inboundReviews[normalized.idempotency_key] = {
    inbound_message_id: normalized.inbound_message_id,
    received_at:        normalized.received_at || new Date().toISOString(),
    review_at:          new Date().toISOString(),
    proposed_next_action: review.proposed_next_action || null,
    proposed_luna_reply:  proposedReply,
    review,
    slim_guest_context_for_next_turn: slimGuestContext,
  };

  const nextMeta = {
    ...existingMeta,
    source:              'luna_inbound_review_dry_run',
    channel:             normalized.channel,
    luna_guest_context:  slimGuestContext,
    luna_inbound_reviews: inboundReviews,
    last_inbound_message_id: normalized.inbound_message_id,
    last_inbound_at:     normalized.received_at || new Date().toISOString(),
  };

  if (row && row.conversation_id) {
    const upd = await pg.query(
      `UPDATE conversations
          SET metadata = $2::jsonb,
              staff_reply_draft = COALESCE($3, staff_reply_draft),
              last_message_preview = $4,
              updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING id::text AS conversation_id`,
      [row.conversation_id, JSON.stringify(nextMeta), proposedReply, preview],
    );
    return upd.rows[0].conversation_id;
  }

  const ins = await pg.query(
    `INSERT INTO conversations (
       client_id,
       phone,
       status,
       bot_mode,
       conversation_stage,
       metadata,
       last_message_preview,
       staff_reply_draft
     ) VALUES (
       $1, $2, 'open'::conversation_status, 'bot'::bot_mode, 'guest_whatsapp_inbound',
       $3::jsonb, $4, $5
     )
     ON CONFLICT (client_id, phone) DO UPDATE SET
       metadata = conversations.metadata || EXCLUDED.metadata,
       staff_reply_draft = COALESCE(EXCLUDED.staff_reply_draft, conversations.staff_reply_draft),
       last_message_preview = EXCLUDED.last_message_preview,
       updated_at = NOW()
     RETURNING id::text AS conversation_id`,
    [clientId, normalized.guest_phone, JSON.stringify(nextMeta), preview, proposedReply],
  );
  return ins.rows[0].conversation_id;
}

/**
 * Run inbound guest review dry-run (orchestrator + optional conversation artifact persistence).
 *
 * @param {object} body — n8n-shaped inbound payload
 * @param {{ pg?: object }} context
 */
async function runGuestInboundReviewDryRun(body, context) {
  const validation = validateInboundReviewBody(body);
  if (!validation.ok) {
    return {
      ok:                false,
      status:            400,
      error:             `${validation.missing.join(', ')} ${validation.missing.length === 1 ? 'is' : 'are'} required`,
      dry_run:           true,
      sends_whatsapp:    false,
      live_send_blocked: true,
    };
  }

  const normalized = validation.normalized;
  const pg = context && context.pg;

  if (!pg) {
    const orchOut = await runGuestAutomationOrchestratorDryRun({
      client_slug:             normalized.client_slug,
      channel:                 normalized.channel,
      message_text:            normalized.message_text,
      guest_phone:             normalized.guest_phone,
      guest_name:              normalized.guest_name,
      contact_name:            normalized.contact_name,
      conversation_id:         normalized.conversation_id,
      language_hint:           normalized.language_hint,
      guest_context:           mergeGuestContext(null, normalized.guest_context),
      reference_date:          normalized.reference_date,
      automation_gate_context: {
        ...(normalized.automation_gate_context || {}),
        public_guest_automation_enabled: false,
        whatsapp_dry_run:                true,
        live_send_allowed:               false,
      },
      dry_run:                 true,
    }, {
      reference_date: normalized.reference_date || undefined,
      guest_phone:    normalized.guest_phone,
      guest_name:     normalized.guest_name,
      contact_name:   normalized.contact_name,
      dry_run:        true,
    });

    return {
      ok:     true,
      status: 200,
      body:   buildInboundReviewResponse({
        orchOut,
        normalized,
        conversationId:           normalized.conversation_id,
        idempotentReplay:         false,
        reviewPersistencePerformed: false,
      }),
    };
  }

  const clientId = await resolveClientId(pg, normalized.client_slug);
  if (!clientId) {
    return {
      ok:                false,
      status:            404,
      error:             'client not found',
      dry_run:           true,
      sends_whatsapp:    false,
      live_send_blocked: true,
    };
  }

  let convRow = await loadConversationRow(pg, {
    clientId,
    conversationId: normalized.conversation_id,
    guestPhone:     normalized.guest_phone,
  });

  if (normalized.conversation_id && !convRow) {
    return {
      ok:                false,
      status:            404,
      error:             'conversation not found',
      dry_run:           true,
      sends_whatsapp:    false,
      live_send_blocked: true,
    };
  }

  const existingMeta = convRow ? parseMetadata(convRow.metadata) : {};
  const cached = getCachedInboundReview(existingMeta, normalized.idempotency_key);
  if (cached) {
    return {
      ok:     true,
      status: 200,
      body:   {
        ...buildInboundReviewResponse({
          orchOut: {
            success:                 true,
            automation_gate:         cached.review.automation_gate,
            proposed_next_action:    cached.review.proposed_next_action,
            proposed_luna_reply:     cached.review.proposed_luna_reply,
            result:                  cached.review.result,
            availability:            cached.review.availability,
            quote:                   cached.review.quote,
            payment_choice:          cached.review.payment_choice,
            hold_payment_draft_plan: cached.review.hold_payment_draft_plan,
          },
          normalized,
          conversationId:           convRow && convRow.conversation_id,
          idempotentReplay:         true,
          reviewPersistencePerformed: true,
        }),
        slim_guest_context_for_next_turn: cached.slim_guest_context_for_next_turn
          || slimGuestContextForNextTurn(cached.review),
      },
    };
  }

  const storedGuestContext = existingMeta.luna_guest_context || null;
  const mergedGuestContext = mergeGuestContext(storedGuestContext, normalized.guest_context);
  const automationGateContext = await buildAutomationGateContext(pg, normalized, convRow);

  const orchOut = await runGuestAutomationOrchestratorDryRun({
    client_slug:             normalized.client_slug,
    channel:                 normalized.channel,
    message_text:            normalized.message_text,
    guest_phone:             normalized.guest_phone,
    guest_name:              normalized.guest_name,
    contact_name:            normalized.contact_name,
    conversation_id:         convRow && convRow.conversation_id,
    language_hint:           normalized.language_hint,
    guest_context:           mergedGuestContext,
    reference_date:          normalized.reference_date,
    automation_gate_context: automationGateContext,
    dry_run:                 true,
  }, {
    reference_date: normalized.reference_date || undefined,
    guest_phone:    normalized.guest_phone,
    guest_name:     normalized.guest_name,
    contact_name:   normalized.contact_name,
    dry_run:        true,
    pg,
  });

  const review = buildReviewFromOrchestrator(orchOut);
  const slimGuestContext = slimGuestContextForNextTurn(review);

  let conversationId = convRow && convRow.conversation_id;
  let reviewPersistencePerformed = false;

  try {
    conversationId = await persistInboundReviewArtifact(pg, {
      clientId,
      normalized,
      convRow,
      review,
      slimGuestContext,
    });
    reviewPersistencePerformed = true;
  } catch (_) {
    reviewPersistencePerformed = false;
  }

  return {
    ok:     true,
    status: 200,
    body:   buildInboundReviewResponse({
      orchOut,
      normalized,
      conversationId,
      idempotentReplay: false,
      reviewPersistencePerformed,
    }),
  };
}

module.exports = {
  INBOUND_REVIEW_ROUTE,
  buildInboundReviewIdempotencyKey,
  validateInboundReviewBody,
  collectGuestAutomationReviewHandoffReasons,
  buildReviewFromOrchestrator,
  slimGuestContextForNextTurn,
  guestContextFromReviewBody,
  runGuestInboundReviewDryRun,
};
