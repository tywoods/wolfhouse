'use strict';

/**
 * Shared fixture expectation checks for conversation + multilingual batch runners.
 */

const { isFormDevCopy, FORBIDDEN_GUEST_PHRASES } = require('./luna-guest-reply-style-contract');

const INTERNAL_LANGUAGE_BLACKLIST = [
  ...FORBIDDEN_GUEST_PHRASES,
  'payment choice', 'quote_status', 'guest_context', 'intake_state',
  'next_safe_step', 'dry run', 'idempotency',
];

const PARTIAL_FAILURE_PATTERNS = [
  /reply_contains/i,
  /expected_reply_source/i,
  /expected_composer_state/i,
  /composer tone/i,
  /min_cami_score/i,
  /min_avg_cami_score/i,
  /max_same_opener_count/i,
];

const FAILURE_CATEGORY_RULES = [
  { pattern: /expected_language|detected_language/i, category: 'language_detection' },
  { pattern: /check_in|check_out|expected_dates|date/i, category: 'date_parsing' },
  { pattern: /guest_count/i, category: 'guest_count' },
  { pattern: /package/i, category: 'package_intent' },
  { pattern: /service_interest|yoga|meal|dinner|wetsuit|surfboard|lesson|addon/i, category: 'service/add-on_intent' },
  { pattern: /context_preserved|transfer|cash/i, category: 'side-question_context' },
  { pattern: /stale_quote|corrected_fields|payment_link_before/i, category: 'stale_quote/correction' },
  { pattern: /reset/i, category: 'reset' },
  { pattern: /internal language|reply_contains|reply_not_contains/i, category: 'composer_tone' },
];

function findInternalLanguage(text) {
  const lower = String(text || '').toLowerCase();
  return INTERNAL_LANGUAGE_BLACKLIST.filter((term) => lower.includes(term.toLowerCase()));
}

function isHandoff(out) {
  const r = (out && out.result) || out || {};
  if (r.safe_handoff_required === true) return true;
  if (out && out.proposed_next_action === 'staff_handoff_required') return true;
  const gate = (out && out.automation_gate) || {};
  return gate.gate_status === 'blocked' || gate.gate_status === 'staff_handoff';
}

function checkObjectSubset(expected, actual, label) {
  const failures = [];
  if (!expected || typeof expected !== 'object') return failures;
  for (const [key, val] of Object.entries(expected)) {
    const got = actual && actual[key];
    if (Array.isArray(val) && Array.isArray(got)) {
      for (const item of val) {
        if (!got.includes(item)) failures.push(`${label}.${key} missing ${item}`);
      }
    } else if (got !== val) {
      failures.push(`${label}.${key} expected ${JSON.stringify(val)} got ${JSON.stringify(got)}`);
    }
  }
  return failures;
}

function checkTurnExpectations(expect, out, extras) {
  const failures = [];
  if (!expect || typeof expect !== 'object') return failures;
  const reply = String(out.proposed_luna_reply || (out.result && out.result.proposed_luna_reply) || '');
  const fields = (out.result && out.result.extracted_fields) || {};
  const policy = (out.result && out.result.booking_intake_policy) || {};
  const tone = extras && extras.tone;
  const priorReplies = (extras && extras.priorReplies) || [];

  if (Array.isArray(expect.reply_contains)) {
    for (const needle of expect.reply_contains) {
      if (!reply.toLowerCase().includes(String(needle).toLowerCase())) {
        failures.push(`reply_contains "${needle}" missing`);
      }
    }
  }
  if (Array.isArray(expect.reply_not_contains)) {
    for (const needle of expect.reply_not_contains) {
      if (reply.toLowerCase().includes(String(needle).toLowerCase())) {
        failures.push(`reply_not_contains "${needle}" found`);
      }
    }
  }
  failures.push(...checkObjectSubset(expect.expected_fields, fields, 'expected_fields'));

  if (expect.expected_language != null || expect.expected_detected_language != null) {
    const want = expect.expected_language || expect.expected_detected_language;
    const got = (out.result && out.result.detected_language) || null;
    const allowed = Array.isArray(want) ? want : [want];
    if (!allowed.some((l) => String(got || '').toLowerCase().startsWith(String(l).toLowerCase().slice(0, 2)))) {
      failures.push(`expected_language ${JSON.stringify(want)} got ${got}`);
    }
  }

  if (Array.isArray(expect.expected_service_interest)) {
    const got = Array.isArray(fields.service_interest) ? fields.service_interest : [];
    for (const code of expect.expected_service_interest) {
      if (!got.includes(code)) failures.push(`expected_service_interest missing ${code}`);
    }
  }

  if (expect.expected_yoga_request === true) {
    if (!(fields.yoga_request && typeof fields.yoga_request === 'object')) {
      failures.push('expected_yoga_request but yoga_request missing');
    }
  }
  if (expect.expected_meals_request === true) {
    if (!(fields.meals_request && typeof fields.meals_request === 'object')) {
      failures.push('expected_meals_request but meals_request missing');
    }
  }

  if (expect.expected_booking_flow_stage != null
    && policy.booking_flow_stage !== expect.expected_booking_flow_stage) {
    failures.push(`expected_booking_flow_stage ${expect.expected_booking_flow_stage} got ${policy.booking_flow_stage}`);
  }
  if (expect.expected_no_handoff === true && isHandoff(out)) {
    failures.push('expected_no_handoff but handoff required');
  }
  if (expect.expected_payment_choice != null) {
    const pc = out.payment_choice && out.payment_choice.payment_choice;
    if (pc !== expect.expected_payment_choice) {
      failures.push(`expected_payment_choice ${expect.expected_payment_choice} got ${pc}`);
    }
  }
  if (expect.expected_quote_ready === true) {
    const qs = out.quote && out.quote.quote_status;
    if (qs !== 'ready') failures.push(`expected_quote_ready but quote_status=${qs}`);
  }
  if (expect.expected_quote_ready === false) {
    const qs = out.quote && out.quote.quote_status;
    if (qs === 'ready') failures.push('expected_quote_ready false but quote is ready');
  }
  if (expect.expected_stale_quote === true) {
    const stale = (out.result && out.result.previous_quote_invalidated === true)
      || (out.quote && out.quote.quote_stale === true)
      || (out.quote && out.quote.previous_quote_invalidated === true);
    if (!stale) failures.push('expected_stale_quote but quote was not invalidated');
  }
  if (expect.expected_stale_quote === false) {
    const stale = (out.result && out.result.previous_quote_invalidated === true)
      || (out.quote && out.quote.quote_stale === true);
    if (stale) failures.push('expected_stale_quote false but quote was invalidated');
  }
  if (expect.expected_stale_quote_reason != null) {
    const reason = (out.result && out.result.stale_quote_reason)
      || (out.quote && out.quote.stale_quote_reason);
    if (String(reason) !== String(expect.expected_stale_quote_reason)) {
      failures.push(`expected_stale_quote_reason ${expect.expected_stale_quote_reason} got ${reason}`);
    }
  }
  if (Array.isArray(expect.expected_corrected_fields)) {
    const got = (out.result && out.result.corrected_fields)
      || (out.quote && out.quote.corrected_fields)
      || [];
    for (const field of expect.expected_corrected_fields) {
      if (!got.includes(field)) failures.push(`expected_corrected_fields missing ${field}`);
    }
  }
  if (expect.expected_reset_detected === true) {
    if (!(out.result && out.result.new_booking_reset === true)) {
      failures.push('expected_reset_detected but new_booking_reset not set');
    }
  }
  if (expect.expected_package != null) {
    const pkg = fields.package_interest;
    if (String(pkg).toLowerCase() !== String(expect.expected_package).toLowerCase()) {
      failures.push(`expected_package ${expect.expected_package} got ${pkg}`);
    }
  }
  if (expect.expected_guest_count != null && fields.guest_count !== expect.expected_guest_count) {
    failures.push(`expected_guest_count ${expect.expected_guest_count} got ${fields.guest_count}`);
  }
  if (expect.expected_dates != null) {
    if (expect.expected_dates.check_in && fields.check_in !== expect.expected_dates.check_in) {
      failures.push(`expected check_in ${expect.expected_dates.check_in} got ${fields.check_in}`);
    }
    if (expect.expected_dates.check_out && fields.check_out !== expect.expected_dates.check_out) {
      failures.push(`expected check_out ${expect.expected_dates.check_out} got ${fields.check_out}`);
    }
  }
  if (expect.expected_no_payment_link_before_updated_quote === true) {
    if (/checkout\.stripe\.com/i.test(reply)) {
      failures.push('stripe payment link present before updated quote');
    }
  }
  if (expect.expected_context_preserved === true) {
    const hasDates = fields.check_in && fields.check_out;
    const hasGuests = fields.guest_count != null;
    if (!hasDates && !hasGuests && !fields.package_interest) {
      failures.push('expected_context_preserved but booking fields missing');
    }
  }
  if (expect.no_internal_language === true) {
    const bad = findInternalLanguage(reply);
    if (bad.length) failures.push(`internal language: ${bad.join(', ')}`);
  }
  if (expect.no_form_dev_copy === true && isFormDevCopy(reply)) {
    failures.push('form/dev copy detected in reply');
  }
  if (expect.min_cami_score != null) {
    const score = tone && tone.cami_score != null
      ? tone.cami_score
      : (() => {
        try {
          const { judgeCamiTone } = require('./luna-cami-tone-judge');
          return judgeCamiTone(reply, { priorReplies }).cami_score;
        } catch (_) {
          return 0;
        }
      })();
    if (score < Number(expect.min_cami_score)) {
      failures.push(`min_cami_score ${expect.min_cami_score} got ${score}`);
    }
  }
  if (expect.no_fake_confirmation === true) {
    if (/\b(?:you(?:'|')?re confirmed|booking is confirmed|payment received|your booking is held)\b/i.test(reply)) {
      failures.push('no_fake_confirmation but confirmation/hold language found');
    }
  }
  if (expect.no_bare_refusal === true) {
    try {
      const { hasBareRefusal } = require('./luna-cami-tone-judge');
      if (hasBareRefusal(reply)) failures.push('no_bare_refusal but bare_refusal detected');
    } catch (_) {
      /* tone judge optional */
    }
  }
  if (expect.no_italian_payment_closer === true) {
    if (/\b(bacioni|un abbraccio|a domani)\b/i.test(reply)) {
      failures.push('no_italian_payment_closer but Italian/heavy closer found');
    }
  }
  if (expect.expected_message_lane != null) {
    const lane = (out.result && out.result.message_lane) || null;
    if (lane !== expect.expected_message_lane) {
      failures.push(`expected_message_lane ${expect.expected_message_lane} got ${lane}`);
    }
  }
  if (expect.expected_reply_source != null) {
    const src = (out.result && out.result.conversation_brain && out.result.conversation_brain.final_reply_source);
    if (src !== expect.expected_reply_source) {
      failures.push(`expected_reply_source ${expect.expected_reply_source} got ${src}`);
    }
  }
  if (expect.expected_composer_state != null) {
    const cs = (out.result && out.result.conversation_brain && out.result.conversation_brain.composer_state);
    if (cs !== expect.expected_composer_state) {
      failures.push(`expected_composer_state ${expect.expected_composer_state} got ${cs}`);
    }
  }
  if (expect.expected_accommodation_only === true) {
    const pkg = String(fields.package_interest || '').toLowerCase();
    if (pkg && pkg !== 'accommodation_only') {
      failures.push(`expected_accommodation_only but package_interest=${pkg}`);
    }
  }
  return failures;
}

function checkFinalExpectations(finalExpect, lastOut, allTurns) {
  const failures = [];
  if (!finalExpect || typeof finalExpect !== 'object') return failures;
  const fields = (lastOut.result && lastOut.result.extracted_fields) || {};

  failures.push(...checkObjectSubset(finalExpect.expected_fields, fields, 'final.expected_fields'));

  if (finalExpect.no_internal_language === true) {
    for (const t of allTurns) {
      if (t.internal_language && t.internal_language.length) {
        failures.push(`internal language turn ${t.turn}: ${t.internal_language.join(', ')}`);
      }
    }
  }
  if (finalExpect.no_handoff === true) {
    if (isHandoff(lastOut)) failures.push('final handoff required');
  }
  if (finalExpect.expected_payment_choice != null) {
    const pc = lastOut.payment_choice && lastOut.payment_choice.payment_choice;
    if (pc !== finalExpect.expected_payment_choice) {
      failures.push(`final expected_payment_choice ${finalExpect.expected_payment_choice} got ${pc}`);
    }
  }
  if (finalExpect.expected_quote_ready === true) {
    const qs = lastOut.quote && lastOut.quote.quote_status;
    if (qs !== 'ready') failures.push(`final expected_quote_ready but quote_status=${qs}`);
  }
  if (finalExpect.expected_language != null) {
    const got = (lastOut.result && lastOut.result.detected_language) || null;
    const allowed = Array.isArray(finalExpect.expected_language)
      ? finalExpect.expected_language
      : [finalExpect.expected_language];
    if (!allowed.some((l) => String(got || '').toLowerCase().startsWith(String(l).toLowerCase().slice(0, 2)))) {
      failures.push(`final expected_language ${JSON.stringify(allowed)} got ${got}`);
    }
  }
  return failures;
}

function classifyFixtureResult(failures, expect, out) {
  if (!failures || failures.length === 0) return 'PASS';
  const hard = [];
  const soft = [];
  for (const f of failures) {
    const isSoft = PARTIAL_FAILURE_PATTERNS.some((re) => re.test(f))
      || (expect && expect.allow_partial === true);
    if (isSoft) soft.push(f);
    else hard.push(f);
  }
  if (hard.length) return 'FAIL';
  if (soft.length) return 'PARTIAL';
  const fields = (out && out.result && out.result.extracted_fields) || {};
  if (expect && expect.expected_quote_ready === true && out.quote && out.quote.quote_status === 'ready') {
    return 'PARTIAL';
  }
  if (expect && expect.expected_fields && Object.keys(expect.expected_fields).length) {
    const subsetFails = checkObjectSubset(expect.expected_fields, fields, 'expected_fields');
    if (subsetFails.length && subsetFails.length < Object.keys(expect.expected_fields).length) {
      return 'PARTIAL';
    }
  }
  return 'FAIL';
}

function categorizeFailure(failureText) {
  for (const rule of FAILURE_CATEGORY_RULES) {
    if (rule.pattern.test(failureText)) return rule.category;
  }
  return 'other';
}

module.exports = {
  checkTurnExpectations,
  checkFinalExpectations,
  findInternalLanguage,
  isHandoff,
  classifyFixtureResult,
  categorizeFailure,
  INTERNAL_LANGUAGE_BLACKLIST,
};
