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
const { evaluateLunaGuestReplySendEligibility } = require('./luna-guest-reply-send-eligibility');
const {
  buildPlaybookMetadata,
  buildPlaybookPromptContext,
  buildConfigAlignmentWarnings,
  getMissingFieldPrompt,
  getHandoffTemplate,
  buildQuoteReplyFromPlaybook,
  loadLunaMessagingPlaybook,
} = require('./luna-client-messaging-playbook');

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

function buildSuggestedReply(extraction, validation, dryRunPlan, playbookOpts = {}) {
  const clientSlug = playbookOpts.clientSlug || extraction.client_slug || 'wolfhouse-somo';
  const playbookLoaded = playbookOpts.playbookLoaded === true;

  if (extraction.handoff_required && extraction.handoff_reason === 'low_confidence') {
    const playbookReply = playbookLoaded
      ? getHandoffTemplate(clientSlug, 'low_confidence', extraction.language)
      : null;
    return {
      suggested_reply: playbookReply || pickLocalized(UNSUPPORTED_DRAFT_BY_LANG, extraction.language),
      next_action:     'unsupported',
    };
  }

  if (extraction.handoff_required) {
    const playbookReply = playbookLoaded
      ? getHandoffTemplate(clientSlug, extraction.handoff_reason, extraction.language)
      : null;
    return {
      suggested_reply: playbookReply || pickLocalized(HANDOFF_DRAFT_BY_LANG, extraction.language),
      next_action:     'handoff_to_staff',
    };
  }

  if (extraction.ask_next) {
    let suggested_reply = extraction.ask_next;
    if (playbookLoaded && Array.isArray(extraction.missing_fields) && extraction.missing_fields.length) {
      const playbookPrompt = getMissingFieldPrompt(
        clientSlug,
        extraction.missing_fields[0],
        extraction.language,
      );
      if (playbookPrompt) suggested_reply = playbookPrompt;
    }
    return {
      suggested_reply,
      next_action: 'ask_missing_field',
    };
  }

  if (dryRunPlan && dryRunPlan.reply_draft) {
    const next = dryRunPlan.next_action === 'show_availability_options'
      ? 'show_quote'
      : (dryRunPlan.next_action || 'show_quote');
    const nextAction = next === 'ask_missing_details' ? 'ask_missing_field' : next;

    let suggested_reply = dryRunPlan.reply_draft;
    if (playbookLoaded && (nextAction === 'show_quote' || dryRunPlan.next_action === 'show_quote')) {
      const quote = dryRunPlan.booking_preview && dryRunPlan.booking_preview.quote;
      const fields = (dryRunPlan.booking_preview && dryRunPlan.booking_preview.fields) || {};
      const playbookQuote = buildQuoteReplyFromPlaybook(clientSlug, extraction.language, quote, {
        check_in:      fields.check_in || extraction.check_in,
        check_out:     fields.check_out || extraction.check_out,
        guest_count:   fields.guest_count ?? extraction.guests,
        package_code:  fields.package_code || extraction.package_code,
      });
      if (playbookQuote) suggested_reply = playbookQuote;
    }

    return {
      suggested_reply,
      next_action: nextAction,
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

  const clientSlug = ex.client_slug || body.client_slug || 'wolfhouse-somo';
  const playbookLoad = loadLunaMessagingPlaybook(clientSlug);
  const messaging_playbook = buildPlaybookMetadata(clientSlug);
  const playbook_prompt_context = buildPlaybookPromptContext(clientSlug);
  const config_alignment_warnings = buildConfigAlignmentWarnings(clientSlug);

  const { suggested_reply, next_action } = buildSuggestedReply(ex, validation, dryRunPlan, {
    clientSlug,
    playbookLoaded: playbookLoad.playbook_loaded,
  });

  const draft = {
    success:           extraction.success !== false,
    ...DRAFT_SAFETY_FLAGS,
    client_slug:         clientSlug,
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
    messaging_playbook,
    playbook_prompt_context,
    blocked_live_actions: BLOCKED_LIVE_ACTIONS,
  };

  if (config_alignment_warnings.length) {
    draft.config_alignment_warnings = config_alignment_warnings;
  }

  draft.send_eligibility = evaluateLunaGuestReplySendEligibility(
    draft,
    body,
    (context && context.env) || process.env,
  );

  return draft;
}

module.exports = {
  buildLunaGuestReplyDraft,
  buildSuggestedReply,
  DRAFT_SAFETY_FLAGS,
  BLOCKED_LIVE_ACTIONS,
  HANDOFF_DRAFT_BY_LANG,
  UNSUPPORTED_DRAFT_BY_LANG,
};
