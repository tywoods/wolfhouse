'use strict';

/**
 * Structured closure context for the guest-facing model.
 * Staff Pricing owns facts; the model owns all localized prose and date wording.
 */
function normalizeGuestLang(language) {
  return String(language || '').trim().toLowerCase().slice(0, 16) || null;
}

function isClosedSeasonQuote(quote) { return !!(quote && quote.closed_season); }

function validIso(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function validRange(value) {
  return value && validIso(value.check_in) && validIso(value.check_out);
}

function buildBotClosedSeasonReply({
  language,
  nearest_open_dates: nearest,
  season_reopens_on: reopens,
  partial_open_dates: partial,
  closed_nights: closedNights,
  unknown_nights: unknownNights,
} = {}) {
  const facts = {
    language: normalizeGuestLang(language),
    partial_open_dates: validRange(partial) ? {
      check_in: partial.check_in,
      check_out: partial.check_out,
      ...(validIso(partial.closed_from) ? { closed_from: partial.closed_from } : {}),
    } : null,
    closed_nights: Array.isArray(closedNights) ? closedNights.filter(validIso) : [],
    unknown_nights: Array.isArray(unknownNights) ? unknownNights.filter(validIso) : [],
    season_reopens_on: validIso(reopens) ? reopens : null,
    nearest_open_dates: validRange(nearest) ? { check_in: nearest.check_in, check_out: nearest.check_out } : null,
  };
  return {
    reply_draft: null,
    guest_safe_next_action: null,
    structured_guest_context: facts,
    prompt_instruction: 'Write the closure facts naturally in the guest language. Render dates naturally, preserve the established form of address and register, and do not add availability not present in the structured facts.',
  };
}

module.exports = { normalizeGuestLang, isClosedSeasonQuote, buildBotClosedSeasonReply };
