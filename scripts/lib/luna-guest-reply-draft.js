/**
 * Phase 18b — Luna guest reply draft builder (draft-only, no send/write).
 *
 * inbound message → intake → validation → optional dry-run → suggested_reply
 */

'use strict';

const {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
  buildDryRunInputFromIntake,
} = require('./luna-guest-message-intake');
const { runLunaGuestBookingDryRun } = require('./luna-guest-booking-dry-run');

const DRAFT_SAFETY_FLAGS = {
  draft_only:                   true,
  preview_only:                 true,
  no_write_performed:           true,
  requires_staff_review:        true,
  sends_whatsapp:               false,
  whatsapp_sent:                false,
  calls_n8n:                    false,
  creates_booking:              false,
  creates_payment:              false,
  creates_stripe_link:          false,
  updates_confirmation_sent_at: false,
};

const BLOCKED_LIVE_ACTIONS = [
  'whatsapp_send',
  'booking_create',
  'stripe_link',
  'confirmation_send',
];

const HANDOFF_DRAFT_BY_LANG = {
  en: 'Thank you for your message. A team member will review this and get back to you shortly.',
  it: 'Grazie per il messaggio. Un membro del team lo esaminerà e ti risponderà al più presto.',
  es: 'Gracias por tu mensaje. Un miembro del equipo lo revisará y te responderá pronto.',
  fr: 'Merci pour votre message. Un membre de l\'équipe l\'examinera et vous répondra sous peu.',
  de: 'Danke für deine Nachricht. Ein Teammitglied wird sie prüfen und sich bald bei dir melden.',
};

const UNSUPPORTED_DRAFT_BY_LANG = {
  en: 'Thanks for reaching out. Our team will review your message and suggest a reply.',
  it: 'Grazie per averci scritto. Il nostro team esaminerà il messaggio e suggerirà una risposta.',
  es: 'Gracias por escribirnos. Nuestro equipo revisará el mensaje y sugerirá una respuesta.',
  fr: 'Merci de nous avoir contactés. Notre équipe examinera le message et proposera une réponse.',
  de: 'Danke für deine Nachricht. Unser Team wird sie prüfen und einen Antwortvorschlag erstellen.',
};

function resolveLang(language) {
  const code = String(language || 'en').trim().toLowerCase().slice(0, 2);
  return HANDOFF_DRAFT_BY_LANG[code] ? code : 'en';
}

function pickLocalized(map, language) {
  const lang = resolveLang(language);
  return map[lang] || map.en;
}

function buildSuggestedReply(extraction, validation, dryRunPlan) {
  if (extraction.handoff_required && extraction.handoff_reason === 'low_confidence') {
    return {
      suggested_reply: pickLocalized(UNSUPPORTED_DRAFT_BY_LANG, extraction.language),
      next_action:     'unsupported',
    };
  }

  if (extraction.handoff_required) {
    return {
      suggested_reply: pickLocalized(HANDOFF_DRAFT_BY_LANG, extraction.language),
      next_action:     'handoff_to_staff',
    };
  }

  if (extraction.ask_next) {
    return {
      suggested_reply: extraction.ask_next,
      next_action:     'ask_missing_field',
    };
  }

  if (dryRunPlan && dryRunPlan.reply_draft) {
    const next = dryRunPlan.next_action === 'show_availability_options'
      ? 'show_quote'
      : (dryRunPlan.next_action || 'show_quote');
    return {
      suggested_reply: dryRunPlan.reply_draft,
      next_action:     next === 'ask_missing_details' ? 'ask_missing_field' : next,
    };
  }

  if (extraction.intent === 'unknown' || (validation.valid === false && !validation.can_chain_dry_run)) {
    return {
      suggested_reply: pickLocalized(UNSUPPORTED_DRAFT_BY_LANG, extraction.language),
      next_action:     'unsupported',
    };
  }

  return {
    suggested_reply: pickLocalized(UNSUPPORTED_DRAFT_BY_LANG, extraction.language),
    next_action:     'unsupported',
  };
}

/**
 * @param {object} input - guest message payload
 * @param {object} [context] - { pg, reference_date, runDryRun }
 */
async function buildLunaGuestReplyDraft(input, context = {}) {
  const body = input || {};
  const extraction = extractLunaGuestMessageIntake(body, {
    reference_date: context.reference_date || body.reference_date || undefined,
  });
  const validation = validateLunaGuestMessageIntake(extraction);
  const ex = validation.extraction;

  let dryRunPlan = null;
  if (validation.can_chain_dry_run) {
    const dryRunInput = buildDryRunInputFromIntake(ex, body);
    if (typeof context.runDryRun === 'function') {
      dryRunPlan = await context.runDryRun(dryRunInput, context);
    } else {
      dryRunPlan = await runLunaGuestBookingDryRun(dryRunInput, context);
    }
  }

  const { suggested_reply, next_action } = buildSuggestedReply(ex, validation, dryRunPlan);

  return {
    success:           extraction.success !== false,
    ...DRAFT_SAFETY_FLAGS,
    client_slug:         ex.client_slug || body.client_slug || 'wolfhouse-somo',
    language:            ex.language || body.language || 'en',
    message_text:        ex.message_text || body.message_text || '',
    extraction:          ex,
    validation: {
      valid:             validation.valid,
      errors:            validation.errors,
      warnings:          validation.warnings,
      can_chain_dry_run: validation.can_chain_dry_run,
    },
    dry_run_plan:        dryRunPlan,
    suggested_reply,
    next_action,
    blocked_live_actions: BLOCKED_LIVE_ACTIONS,
  };
}

module.exports = {
  buildLunaGuestReplyDraft,
  buildSuggestedReply,
  DRAFT_SAFETY_FLAGS,
  BLOCKED_LIVE_ACTIONS,
  HANDOFF_DRAFT_BY_LANG,
  UNSUPPORTED_DRAFT_BY_LANG,
};
