'use strict';

/**
 * Stage 50c — Guest agent read-only tool executor.
 *
 * Wraps existing deterministic modules. No writes, Stripe, or WhatsApp sends.
 */

const {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
} = require('./luna-guest-message-intake');
const {
  collectPriorExtractedFields,
  mergeGuestExtractedFields,
} = require('./luna-guest-context-merge');
const {
  buildWhatsAppPackageLines,
  buildPackageChoiceIntakeReply,
} = require('./luna-guest-package-explainer');
const { isGuestAgentReadTool } = require('./luna-guest-agent-tool-plan');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function intakeToRouterFields(intake) {
  const ex = intake || {};
  const out = {};
  if (ex.check_in) out.check_in = ex.check_in;
  if (ex.check_out) out.check_out = ex.check_out;
  if (ex.guests != null) out.guest_count = Number(ex.guests);
  if (ex.package_code) out.package_interest = ex.package_code;
  if (ex.guest_name) out.guest_name = ex.guest_name;
  if (ex.payment_choice) out.payment_preference = ex.payment_choice;
  return out;
}

function resolvePaymentTruth(priorGuestContext) {
  const prior = priorGuestContext || {};
  const truth = prior.payment_truth || (prior.result && prior.result.payment_truth) || null;
  const status = truth && trimStr(truth.payment_status).toLowerCase();
  if (status === 'paid' || status === 'deposit_paid' || status === 'fully_paid') {
    return { known: true, status };
  }
  return { known: false, status: null };
}

/**
 * Execute one read-only guest agent tool.
 * ctx: {
 *   tool_id, client_slug, message_text, prior_guest_context, reference_date,
 *   language, contact_name, guest_phone, chain_snapshot,
 * }
 */
function executeGuestAgentReadTool(toolId, ctx) {
  const id = trimStr(toolId);
  if (!isGuestAgentReadTool(id)) {
    return {
      tool_id: id,
      status: 'rejected',
      error: 'not_a_read_tool',
      result: null,
    };
  }

  const prior = ctx.prior_guest_context || {};
  const priorFields = collectPriorExtractedFields(prior);
  const lang = trimStr(ctx.language) || 'en';

  if (id === 'get_conversation_context') {
    return {
      tool_id: id,
      status: 'ok',
      result: {
        prior_extracted_fields: priorFields,
        intake_state: (prior.result && prior.result.intake_state) || null,
        message_lane: (prior.result && prior.result.message_lane) || null,
        quote_status: (prior.quote && prior.quote.quote_status) || 'not_ready',
        availability_status: (prior.availability && prior.availability.availability_status) || 'not_ready',
      },
    };
  }

  if (id === 'collect_missing_booking_fields') {
    const extraction = extractLunaGuestMessageIntake({
      client_slug: ctx.client_slug,
      message_text: ctx.message_text,
      guest_phone: ctx.guest_phone,
      guest_name: ctx.contact_name,
      channel: 'whatsapp',
    }, { reference_date: ctx.reference_date, env: ctx.env });
    const validation = validateLunaGuestMessageIntake(extraction, { env: ctx.env });
    const ex = validation.extraction || extraction;
    const turnFields = intakeToRouterFields(ex);
    const merged = mergeGuestExtractedFields(priorFields, turnFields);
    const missing = [];
    if (!merged.check_in || !merged.check_out) missing.push('dates');
    if (!merged.guest_count) missing.push('guest_count');
    if (!merged.package_interest) missing.push('package_or_accommodation');
    return {
      tool_id: id,
      status: 'ok',
      result: {
        turn_extracted_fields: turnFields,
        merged_extracted_fields: merged,
        missing_fields: missing,
        handoff_required: ex.handoff_required === true,
      },
    };
  }

  if (id === 'explain_packages') {
    const lines = buildWhatsAppPackageLines(lang);
    const fields = { ...priorFields, ...intakeToRouterFields(
      extractLunaGuestMessageIntake({ client_slug: ctx.client_slug, message_text: ctx.message_text }, { reference_date: ctx.reference_date }),
    ) };
    return {
      tool_id: id,
      status: 'ok',
      result: {
        package_lines: [lines.malibu, lines.uluwatu, lines.waimea].filter(Boolean),
        sample_reply: buildPackageChoiceIntakeReply(lang, fields),
      },
    };
  }

  if (id === 'check_availability') {
    const snap = ctx.chain_snapshot || {};
    const av = snap.availability || prior.availability || {};
    if (av.availability_status && av.availability_status !== 'not_run') {
      return {
        tool_id: id,
        status: 'ok',
        result: {
          availability_status: av.availability_status,
          has_enough_beds: av.has_enough_beds === true,
          source: 'chain_snapshot',
        },
      };
    }
    return {
      tool_id: id,
      status: 'deferred',
      result: {
        availability_status: 'not_ready',
        note: 'availability_requires_deterministic_chain',
      },
    };
  }

  if (id === 'quote_booking') {
    const snap = ctx.chain_snapshot || {};
    const quote = snap.quote || prior.quote || {};
    if (quote.quote_status === 'ready') {
      return {
        tool_id: id,
        status: 'ok',
        result: {
          quote_status: quote.quote_status,
          quote_total_cents: quote.quote_total_cents,
          deposit_required_cents: quote.deposit_required_cents,
          package_code: quote.package_code || null,
          source: 'chain_snapshot',
        },
      };
    }
    return {
      tool_id: id,
      status: 'deferred',
      result: {
        quote_status: 'not_ready',
        note: 'quote_requires_deterministic_chain',
      },
    };
  }

  if (id === 'check_payment_status') {
    const truth = resolvePaymentTruth(prior);
    return {
      tool_id: id,
      status: 'ok',
      result: truth,
    };
  }

  if (id === 'summarize_for_staff') {
    return {
      tool_id: id,
      status: 'ok',
      result: {
        summary: `Guest message: ${trimStr(ctx.message_text).slice(0, 200)}`,
        prior_fields: priorFields,
      },
    };
  }

  if (id === 'compose_cami_reply') {
    return {
      tool_id: id,
      status: 'deferred',
      result: { note: 'compose_cami_reply_owned_by_reply_author_stage' },
    };
  }

  return {
    tool_id: id,
    status: 'skipped',
    result: null,
  };
}

module.exports = {
  intakeToRouterFields,
  executeGuestAgentReadTool,
};
