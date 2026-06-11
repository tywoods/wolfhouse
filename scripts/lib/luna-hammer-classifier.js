'use strict';

/**
 * Stage 40a — Hammer test result classification.
 */

const {
  categorizeFailure,
  findInternalLanguage,
  isHandoff,
} = require('./luna-fixture-expectations');

const HAMMER_FAILURE_CATEGORIES = Object.freeze([
  'date_parsing',
  'guest_count',
  'package_intent',
  'accommodation_intent',
  'service_addon_intent',
  'yoga_meals_intent',
  'transfer_side_question',
  'cash_side_question',
  'correction_stale_quote',
  'reset',
  'payment_choice',
  'context_loss',
  'forbidden_language',
  'robotic_copy',
  'hallucinated_availability',
  'stale_payment_link',
  'handoff_unexpected',
  'internal_error',
]);

const HALLUCINATION_PATTERNS = [
  /booking\s+is\s+confirmed/i,
  /your\s+booking\s+is\s+confirmed/i,
  /payment\s+has\s+been\s+received/i,
  /we\s+received\s+your\s+payment/i,
  /beds?\s+are\s+confirmed/i,
  /availability\s+is\s+confirmed/i,
];

const ROBOTIC_PATTERNS = [
  /quote_status/i,
  /payment choice/i,
  /guest_context/i,
  /intake_state/i,
  /I am an AI/i,
];

const CATEGORY_MAP = [
  { re: /check_in|check_out|expected_dates|date/i, cat: 'date_parsing' },
  { re: /guest_count/i, cat: 'guest_count' },
  { re: /expected_package|package_interest(?!.*accommodation)/i, cat: 'package_intent' },
  { re: /accommodation_only|accommodation/i, cat: 'accommodation_intent' },
  { re: /service_interest|wetsuit|surfboard|surf_lesson|lesson|addon/i, cat: 'service_addon_intent' },
  { re: /yoga|meal|dinner|meals_request/i, cat: 'yoga_meals_intent' },
  { re: /transfer|context_preserved.*transfer/i, cat: 'transfer_side_question' },
  { re: /cash|efectivo|contanti|bank/i, cat: 'cash_side_question' },
  { re: /stale_quote|corrected_fields|payment_link_before/i, cat: 'correction_stale_quote' },
  { re: /reset|new_booking_reset/i, cat: 'reset' },
  { re: /payment_choice|deposit|full payment/i, cat: 'payment_choice' },
  { re: /context_preserved|booking fields missing/i, cat: 'context_loss' },
  { re: /internal language|forbidden/i, cat: 'forbidden_language' },
  { re: /reply_contains|form\/dev copy|robotic/i, cat: 'robotic_copy' },
  { re: /stripe payment link|checkout\.stripe/i, cat: 'stale_payment_link' },
  { re: /handoff/i, cat: 'handoff_unexpected' },
];

const FIX_SUGGESTIONS = Object.freeze({
  date_parsing: 'intake date parser / multilingual compact ranges',
  guest_count: 'guest count extraction + solo accommodation guard',
  package_intent: 'package detection + side-question context',
  accommodation_intent: 'accommodation-only intent + short-stay defaults',
  service_addon_intent: 'add-on parsing (muta/tavola/board/lesson)',
  yoga_meals_intent: 'reactive services policy + composer ack',
  transfer_side_question: 'transfer explainer + context preservation',
  cash_side_question: 'payment side-Q copy + quote preservation',
  correction_stale_quote: 'quote stale invalidation on field change',
  reset: 'reset phrase detection + context clear',
  payment_choice: 'payment choice dry-run wiring',
  context_loss: 'side-question / mid-flow context merge',
  forbidden_language: 'reply style contract / composer sanitization',
  robotic_copy: 'Cami personality composer templates',
  hallucinated_availability: 'availability/quote truth gating in composer',
  stale_payment_link: 'payment link only after fresh quote',
  handoff_unexpected: 'router handoff thresholds for messy intake',
  internal_error: 'orchestrator crash / missing import',
});

function mapFailureToHammerCategory(text) {
  const t = String(text || '');
  for (const rule of CATEGORY_MAP) {
    if (rule.re.test(t)) return rule.cat;
  }
  const legacy = categorizeFailure(t);
  if (legacy === 'date_parsing') return 'date_parsing';
  if (legacy === 'guest_count') return 'guest_count';
  if (legacy === 'package_intent') return 'package_intent';
  if (legacy === 'service/add-on_intent') return 'service_addon_intent';
  if (legacy === 'side-question_context') return 'context_loss';
  if (legacy === 'stale_quote/correction') return 'correction_stale_quote';
  if (legacy === 'reset') return 'reset';
  if (legacy === 'composer_tone') return 'robotic_copy';
  return 'internal_error';
}

function detectHallucinatedAvailability(reply, out) {
  const text = String(reply || '');
  const quoteReady = out && out.quote && out.quote.quote_status === 'ready';
  if (!quoteReady) {
    for (const re of HALLUCINATION_PATTERNS) {
      if (re.test(text)) return true;
    }
  }
  return false;
}

function detectRoboticCopy(reply) {
  const text = String(reply || '');
  return ROBOTIC_PATTERNS.some((re) => re.test(text));
}

function collectFailureCategories(failures, scenario, flowResult, lastOut) {
  const cats = new Set();
  for (const f of failures || []) {
    cats.add(mapFailureToHammerCategory(f));
  }
  const reply = String(
    (lastOut && lastOut.proposed_luna_reply)
    || (flowResult && flowResult.final && flowResult.final.proposed_luna_reply)
    || '',
  );
  if (findInternalLanguage(reply).length) cats.add('forbidden_language');
  if (detectRoboticCopy(reply)) cats.add('robotic_copy');
  if (detectHallucinatedAvailability(reply, lastOut)) cats.add('hallucinated_availability');
  if (scenario && scenario.hammer_meta) {
    const st = scenario.hammer_meta.scenario_type;
    if (st === 'transfer_side_question' && flowResult.result === 'FAIL') {
      cats.add('transfer_side_question');
    }
    if (st === 'cash_payment_side_question' && flowResult.result === 'FAIL') {
      cats.add('cash_side_question');
    }
    if (st === 'reset_flow' && flowResult.result === 'FAIL') {
      cats.add('reset');
    }
  }
  if (isHandoff(lastOut) && scenario && scenario.final_expect && scenario.final_expect.no_handoff) {
    cats.add('handoff_unexpected');
  }
  return [...cats].filter((c) => HAMMER_FAILURE_CATEGORIES.includes(c));
}

function suggestFixAreas(categories) {
  const areas = [];
  for (const cat of categories || []) {
    if (FIX_SUGGESTIONS[cat] && !areas.includes(FIX_SUGGESTIONS[cat])) {
      areas.push(FIX_SUGGESTIONS[cat]);
    }
  }
  return areas;
}

function buildHammerResultRecord(scenario, flowResult, lastOut, seed) {
  const failures = [
    ...(flowResult.failures || []),
    ...(flowResult.partial_reasons || []),
  ];
  const categories = collectFailureCategories(failures, scenario, flowResult, lastOut);
  const final = flowResult.final || {};
  const fields = final.extracted_fields || {};
  const reply = (lastOut && lastOut.proposed_luna_reply)
    || (lastOut && lastOut.result && lastOut.result.proposed_luna_reply)
    || null;

  return {
    scenario_id: scenario.id,
    scenario_type: scenario.hammer_meta && scenario.hammer_meta.scenario_type,
    language: scenario.language,
    seed,
    style: (scenario.hammer_meta && scenario.hammer_meta.style) || [],
    result: flowResult.result,
    input_turns: (scenario.turns || []).map((t) => (typeof t === 'string' ? t : t.message)),
    final_extracted_fields: fields,
    quote_status: final.quote_status || (lastOut && lastOut.quote && lastOut.quote.quote_status) || null,
    quote_ready: final.quote_ready === true,
    payment_choice_ready: final.payment_choice_ready === true,
    stale_quote: !!(lastOut && lastOut.result && lastOut.result.previous_quote_invalidated),
    stale_quote_reason: (lastOut && lastOut.result && lastOut.result.stale_quote_reason) || null,
    services_detected: Array.isArray(fields.service_interest) ? fields.service_interest : [],
    yoga_request: fields.yoga_request || null,
    meals_request: fields.meals_request || null,
    luna_final_reply: reply,
    failures,
    failure_categories: categories,
    suggested_fix_areas: suggestFixAreas(categories),
    handoff: final.handoff === true || isHandoff(lastOut),
    internal_language: final.internal_language || [],
  };
}

module.exports = {
  HAMMER_FAILURE_CATEGORIES,
  mapFailureToHammerCategory,
  collectFailureCategories,
  suggestFixAreas,
  buildHammerResultRecord,
  detectHallucinatedAvailability,
};
