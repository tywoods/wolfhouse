'use strict';



/**

 * Which composer states own guest copy vs Cami-eligible warmth states.

 *

 * Stage 52 — Cami rewrites intake + quotes + payment warmth; composer keeps payment truth only.

 */



/** Exact payment / confirmation truth — Cami must not rewrite wording that carries URLs or legal state. */

/** URL-bearing or legal confirmation truth — Cami must not rewrite. */
const COMPOSER_OWNED_STATES = Object.freeze([
  'stripe_test_link_created',
  'payment_link_sent',
  'payment_received_preview_ready',
  'confirmation_sent_ack',
  'safe_handoff',
]);



/** Cami GPT may warm these — facts validated before send. */

const CAMI_ELIGIBLE_STATES = Object.freeze([

  'greeting',

  'ask_dates',

  'confirm_dates',

  'ask_guests',

  'ask_guest_name',

  'ask_package',

  'ask_room_preference_girls_mixed',

  'ask_room_preference_private_shared',

  'ask_room_preference_neutral',

  'ask_transfer_info_casual',

  'ask_transfer_times_combined',

  'service_scheduled_ack',

  'transfer_times_updated_ack',

  'ask_package_choice',

  'explain_packages',

  'explain_service_addon',

  'explain_transfer',

  'explain_house_knowledge',

  'explain_surf_report',

  'package_quote_ready',

  'accommodation_quote_ready',

  'ask_addons_after_quote',

  'addons_none_confirmed',

  'ask_payment_choice',

  'answer_arrival_payment_question',

  'payment_choice_ack',

  'payment_choice_received_hold_created',

  'payment_pending_no_link',

  'hold_write_failed',

  'payment_link_failed',

  'post_payment_link_ack',

  'quote_refreshing',

  'clarify_missing_info',

  'contextual_pending_answer',

  'frontdesk_intake',

  'frontdesk_quote',

  'frontdesk_post_booking',

  'frontdesk_general',

]);



function composerOwnedState(composed) {

  const state = composed && composed.composer_state;

  return state && COMPOSER_OWNED_STATES.includes(state);

}



function camiEligibleForState(composed, payload) {

  if (!composed || !composed.covered || !String(composed.reply || '').trim()) return false;

  const state = composed.composer_state;

  if (state && CAMI_ELIGIBLE_STATES.includes(state)) return true;

  const result = (payload && payload.result) || {};

  const quote = (payload && payload.quote) || {};

  if (quote.quote_status === 'ready') return true;

  if (result.greeting_only === true) return true;

  return false;

}



const FRONTDESK_CAMI_STATES = new Set([

  'frontdesk_intake',

  'frontdesk_quote',

  'frontdesk_post_booking',

  'frontdesk_general',

]);

/** Factual copy — Cami must not rewrite (packages, quotes, payment). */
const CAMI_SKIP_TRUTH_STATES = new Set([
  'explain_packages',
  'package_quote_ready',
  'ask_payment_choice',
  'payment_choice_ack',
  'accommodation_quote_ready',
  'addons_none_confirmed',
  'answer_arrival_payment_question',
]);



function isComposerBypassEnabled(env) {

  return String((env || process.env).LUNA_GUEST_COMPOSER_BYPASS_ENABLED || '').toLowerCase() === 'true';

}



function isComposerAskState(state) {

  return /^ask_/.test(trimStr(state)) || state === 'clarify_missing_info';

}



function trimStr(v) {

  return v == null ? '' : String(v).trim();

}



function shouldSkipCamiAuthor(args) {

  const a = args || {};

  const composed = a.composed;

  const payload = a.payload || {};

  const env = a.env || process.env;



  if (a.handoff_result && a.handoff_result.handoff_required) {

    return { skip: true, reason: 'handoff_lane' };

  }

  if (composerOwnedState(composed)) {

    return { skip: true, reason: `composer_owned:${composed.composer_state}` };

  }

  const state = composed && composed.composer_state;

  if (state && CAMI_SKIP_TRUTH_STATES.has(state)) {
    return { skip: true, reason: `truth_state:${state}` };
  }

  if (state && FRONTDESK_CAMI_STATES.has(state)) {

    return { skip: false, reason: null };

  }

  if (composed && composed.cami_author_required === true) {
    return { skip: false, reason: null };
  }

  if (isComposerBypassEnabled(env) && composed && composed.covered) {
    return { skip: false, reason: null };
  }

  if (composed && composed.covered && !camiEligibleForState(composed, payload)) {
    return { skip: true, reason: 'composer_covered_not_cami_eligible' };
  }

  return { skip: false, reason: null };

}



module.exports = {

  COMPOSER_OWNED_STATES,

  CAMI_ELIGIBLE_STATES,

  FRONTDESK_CAMI_STATES,

  composerOwnedState,

  camiEligibleForState,

  isComposerBypassEnabled,

  isComposerAskState,

  shouldSkipCamiAuthor,

};

