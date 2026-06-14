'use strict';

/**
 * Deterministic Luna coach evaluator — scores transcripts against LUNA-GUEST-BEHAVIOR-SPEC.
 * No API key required. Optional GPT layer can be added later behind LUNA_COACH_AGENT_ENABLED.
 */

const fs = require('fs');
const path = require('path');
const { findInternalLanguage } = require('./luna-fixture-expectations');
const { isForbiddenGuestCopy, isFormDevCopy } = require('./luna-guest-reply-style-contract');
const { judgeCamiTone } = require('./luna-cami-tone-judge');

const SPEC_PATH = path.join(__dirname, '..', '..', 'docs', 'LUNA-GUEST-BEHAVIOR-SPEC.md');

const OLD_PACKAGE_ASK_RE = /are you looking for a surf package like malibu, or just accommodation|malibu or (?:just )?accommodation/i;
const STALL_RE = /i can look into (?:the best option|availability)|not confirming availability yet|let me look into the best option/i;
const HANDOFF_RE = /looping in our wolfhouse team|passing this to our team|hand off|handoff|staff will follow up/i;
const FAKE_CONFIRM_RE = /\b(?:you(?:'|')?re confirmed|booking is confirmed|payment received|your booking is held)\b/i;

const FAILURE_CATEGORIES = new Set([
  'intent', 'state', 'tool_use', 'copy', 'truth', 'safety',
  'booking_progress', 'services', 'handoff', 'formatting',
]);

const SHIPPING_BLOCKER_CATEGORIES = new Set(['truth', 'safety', 'handoff']);
const SHIPPING_BLOCKER_SEVERITIES = new Set(['blocker', 'major']);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeTurns(transcript) {
  const raw = transcript || [];
  return raw.map((t, i) => {
    if (typeof t === 'string') return { turn_index: i, guest_message: t, luna_reply: '' };
    const guest = trimStr(t.guest || t.guest_message || t.message);
    const luna = trimStr(t.luna || t.luna_reply || t.reply);
    return { turn_index: i, guest_message: guest, luna_reply: luna, ...t };
  });
}

/** Infer booking fields from guest message text (coach runs on transcripts without orchestrator). */
function inferFieldsFromGuestMessage(text, prior) {
  const out = { ...prior };
  const msg = trimStr(text);
  const countM = msg.match(/\b(\d{1,2})\s*(?:guests?|people|pax)?\b/i);
  if (/^\s*\d+\s*(please|guests?)?\s*$/i.test(msg) && countM) {
    out.guest_count = Number(countM[1]);
  }
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const rangeFull = msg.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+to\s+(\w+)\s+(\d{1,2})/i);
  const rangeSameMonth = msg.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+to\s+(\d{1,2})(?:st|nd|rd|th)?/i);
  const year = 2026;
  if (rangeFull) {
    const m1 = months[rangeFull[1].toLowerCase()];
    const m2 = months[rangeFull[3].toLowerCase()];
    if (m1 && m2) {
      out.check_in = `${year}-${String(m1).padStart(2, '0')}-${String(rangeFull[2]).padStart(2, '0')}`;
      out.check_out = `${year}-${String(m2).padStart(2, '0')}-${String(rangeFull[4]).padStart(2, '0')}`;
    }
  } else if (rangeSameMonth) {
    const m1 = months[rangeSameMonth[1].toLowerCase()];
    if (m1) {
      out.check_in = `${year}-${String(m1).padStart(2, '0')}-${String(rangeSameMonth[2]).padStart(2, '0')}`;
      out.check_out = `${year}-${String(m1).padStart(2, '0')}-${String(rangeSameMonth[3]).padStart(2, '0')}`;
    }
  }
  if (/malibu/i.test(msg)) out.package_interest = 'malibu';
  return out;
}

function paragraphCount(text) {
  return String(text || '').split(/\n\s*\n/).filter((p) => p.trim()).length;
}

function newlineCount(text) {
  return (String(text || '').match(/\n/g) || []).length;
}

function loadBehaviorSpec(inputSpec) {
  if (inputSpec && typeof inputSpec === 'string') return inputSpec;
  if (inputSpec && typeof inputSpec === 'object') return JSON.stringify(inputSpec);
  try {
    return fs.readFileSync(SPEC_PATH, 'utf8');
  } catch {
    return '';
  }
}

function failureEntry(fields) {
  return {
    category: fields.category,
    severity: fields.severity || 'major',
    turn_index: fields.turn_index,
    guest_message: fields.guest_message || '',
    luna_reply: fields.luna_reply || '',
    expected_behavior: fields.expected_behavior || '',
    actual_behavior: fields.actual_behavior || '',
    root_cause_guess: fields.root_cause_guess || '',
    recommended_fix_type: fields.recommended_fix_type || '',
  };
}

function evaluateTurn(turn, ctx) {
  const failures = [];
  const guest = turn.guest_message || '';
  const reply = turn.luna_reply || '';
  const guestLower = guest.toLowerCase();
  const replyLower = reply.toLowerCase();
  const ti = turn.turn_index;
  const fields = (ctx.booking_state && ctx.booking_state.extracted_fields)
    || ctx.expected_context && ctx.expected_context.extracted_fields
    || {};

  if (!reply && guest) {
    failures.push(failureEntry({
      category: 'booking_progress',
      severity: 'major',
      turn_index: ti,
      guest_message: guest,
      luna_reply: reply,
      expected_behavior: 'Luna should reply to every guest message',
      actual_behavior: 'Empty Luna reply',
      root_cause_guess: 'Pipeline produced no reply',
      recommended_fix_type: 'pipeline_debug',
    }));
    return failures;
  }

  const internal = findInternalLanguage(reply);
  if (internal.length || isForbiddenGuestCopy(reply) || isFormDevCopy(reply)) {
    failures.push(failureEntry({
      category: 'copy',
      severity: 'blocker',
      turn_index: ti,
      guest_message: guest,
      luna_reply: reply,
      expected_behavior: 'No internal/system words in guest copy (spec §2)',
      actual_behavior: internal.length ? `internal: ${internal.join(', ')}` : 'forbidden guest copy',
      root_cause_guess: 'Internal copy leaked to guest',
      recommended_fix_type: 'reply_style_contract',
    }));
  }

  if (HANDOFF_RE.test(reply) && !ctx.stage_flags?.handoff_expected) {
    failures.push(failureEntry({
      category: 'handoff',
      severity: 'major',
      turn_index: ti,
      guest_message: guest,
      luna_reply: reply,
      expected_behavior: 'No staff handoff unless explicitly required (spec §8)',
      actual_behavior: 'Handoff copy in reply',
      root_cause_guess: 'handoff_policy_or_brain_over_escalation',
      recommended_fix_type: 'handoff_policy',
    }));
  }

  if (FAKE_CONFIRM_RE.test(reply) && !ctx.stage_flags?.payment_truth_present) {
    failures.push(failureEntry({
      category: 'truth',
      severity: 'blocker',
      turn_index: ti,
      guest_message: guest,
      luna_reply: reply,
      expected_behavior: 'No confirmation/hold claims without payment truth (spec §6.4)',
      actual_behavior: 'Fake confirmation language',
      root_cause_guess: 'cami_author_or_composer_truth_gap',
      recommended_fix_type: 'payment_truth_guard',
    }));
  }

  const isGreeting = /^(hi|hello|hey|hola|ciao|buongiorno)\b/i.test(guestLower) && guest.length < 30;
  if (isGreeting && ti === 0) {
    if (/€\s*\d+/i.test(reply) || (/malibu/i.test(reply) && /uluwatu/i.test(reply))) {
      failures.push(failureEntry({
        category: 'copy',
        severity: 'major',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'Warm welcome only — no price/package dump (spec §3.2)',
        actual_behavior: 'Greeting triggered prices or full package menu',
        root_cause_guess: 'greeting_lane_or_cami_unsolicited_packages',
        recommended_fix_type: 'greeting_intent_gate',
      }));
    }
  }

  const hasDates = fields.check_in && fields.check_out;
  const hasCount = fields.guest_count != null;
  const guestIsCountOnly = /^\s*\d+\s*(please|guests?)?\s*$/i.test(guest);
  const packageNotChosen = !fields.package_interest;
  if (guestIsCountOnly && hasDates && packageNotChosen) {
    if (OLD_PACKAGE_ASK_RE.test(reply)) {
      failures.push(failureEntry({
        category: 'booking_progress',
        severity: 'major',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'Explain package tiers with WhatsApp spacing before naming Malibu/accommodation (spec §5.1)',
        actual_behavior: 'Blind binary package choice without explanation',
        root_cause_guess: 'package_intake_shortcut_after_guest_count',
        recommended_fix_type: 'package_explainer_before_choice',
      }));
    }
  }

  if (/tell me about the packages|what packages|explain packages/i.test(guestLower)) {
    const hasAll = /malibu/i.test(reply) && /uluwatu/i.test(reply) && /waimea/i.test(reply);
    if (!hasAll) {
      failures.push(failureEntry({
        category: 'booking_progress',
        severity: 'major',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'Explain all three package tiers',
        actual_behavior: 'Incomplete package explanation',
        root_cause_guess: 'package_explainer_incomplete',
        recommended_fix_type: 'package_explainer',
      }));
    }
    if (hasAll && newlineCount(reply) < 2 && reply.length > 280) {
      failures.push(failureEntry({
        category: 'formatting',
        severity: 'minor',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'WhatsApp spacing for package blocks (spec §5.2, §9.2)',
        actual_behavior: 'Dense single-block package paragraph',
        root_cause_guess: 'cami_or_explainer_formatting',
        recommended_fix_type: 'whatsapp_spacing',
      }));
    }
  }

  if (hasDates && hasCount && /malibu|uluwatu|waimea|ok malibu/i.test(guestLower)) {
    if (STALL_RE.test(reply)) {
      failures.push(failureEntry({
        category: 'booking_progress',
        severity: 'major',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'Quote or payment choice when intake is complete (spec §6.2)',
        actual_behavior: 'Availability stall phrase',
        root_cause_guess: 'planner_or_composer_readiness_mismatch',
        recommended_fix_type: 'quote_payment_progression',
      }));
    }
    if (!/€|deposit|which do you prefer|pay/i.test(reply) && !STALL_RE.test(reply)) {
      failures.push(failureEntry({
        category: 'booking_progress',
        severity: 'minor',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'Move toward quote/payment after package selection',
        actual_behavior: 'No quote or payment progression visible',
        root_cause_guess: 'quote_chain_not_triggered',
        recommended_fix_type: 'quote_payment_progression',
      }));
    }
  }

  if (/board|wetsuit|lessons?|yoga|meals?|dinner/i.test(guestLower)) {
    if (!/board|wetsuit|lesson|yoga|meal|dinner|service|add/i.test(replyLower)) {
      failures.push(failureEntry({
        category: 'services',
        severity: 'major',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'Acknowledge and capture service intent (spec §7.1)',
        actual_behavior: 'Service mention ignored in reply',
        root_cause_guess: 'service_lane_or_reactive_services_policy',
        recommended_fix_type: 'service_capture',
      }));
    }
  }

  if (/already booked|existing booking/i.test(guestLower) && /yoga|lesson|add/i.test(guestLower)) {
    if (FAKE_CONFIRM_RE.test(reply)) {
      failures.push(failureEntry({
        category: 'truth',
        severity: 'blocker',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'Attach service request without fake confirmation (spec §7.2)',
        actual_behavior: 'Fake confirmation on add-on request',
        root_cause_guess: 'post_booking_lane_misroute',
        recommended_fix_type: 'post_booking_service_attach',
      }));
    }
  }

  if (/airport|pickup|transfer/i.test(guestLower)) {
    if (!/airport|pickup|transfer|flight|arrival/i.test(replyLower)) {
      failures.push(failureEntry({
        category: 'services',
        severity: 'major',
        turn_index: ti,
        guest_message: guest,
        luna_reply: reply,
        expected_behavior: 'Acknowledge transfer request (spec §7.3)',
        actual_behavior: 'Transfer intent not reflected in reply',
        root_cause_guess: 'transfer_explainer_or_lane',
        recommended_fix_type: 'transfer_capture',
      }));
    }
  }

  if (/not sure|what do you offer|hmm/i.test(guestLower) && HANDOFF_RE.test(reply)) {
    failures.push(failureEntry({
      category: 'safety',
      severity: 'major',
      turn_index: ti,
      guest_message: guest,
      luna_reply: reply,
      expected_behavior: 'Vague curiosity should not trigger handoff (spec §8.1)',
      actual_behavior: 'Handoff on uncertain message',
      root_cause_guess: 'implicit_handoff_reason',
      recommended_fix_type: 'handoff_policy',
    }));
  }

  const tone = judgeCamiTone(reply, { priorReplies: ctx.prior_replies || [] });
  if (tone.robotic_flags && tone.robotic_flags.length) {
    failures.push(failureEntry({
      category: 'copy',
      severity: 'minor',
      turn_index: ti,
      guest_message: guest,
      luna_reply: reply,
      expected_behavior: 'Warm human front-desk tone (spec §1)',
      actual_behavior: `Robotic patterns: ${tone.robotic_flags.join(', ')}`,
      root_cause_guess: 'composer_template_or_cami_drift',
      recommended_fix_type: 'cami_voice',
    }));
  }

  return failures;
}

function scoreFromFailures(failures) {
  let score = 100;
  for (const f of failures) {
    if (f.severity === 'blocker') score -= 25;
    else if (f.severity === 'major') score -= 12;
    else score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

function isShippingBlocker(failures) {
  return failures.some((f) =>
    SHIPPING_BLOCKER_CATEGORIES.has(f.category)
    && SHIPPING_BLOCKER_SEVERITIES.has(f.severity));
}

function buildMinimalFixPlan(failures) {
  const seen = new Set();
  const plan = [];
  for (const f of failures) {
    const key = f.recommended_fix_type;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    plan.push({
      fix_type: key,
      owner_hint: ownerHintForFixType(key),
      summary: f.expected_behavior,
    });
  }
  return plan;
}

function ownerHintForFixType(fixType) {
  const map = {
    package_explainer_before_choice: 'scripts/lib/luna-guest-package-explainer.js',
    package_explainer: 'scripts/lib/luna-guest-package-explainer.js',
    quote_payment_progression: 'scripts/lib/luna-guest-frontdesk-planner.js + orchestrator chain',
    handoff_policy: 'scripts/lib/luna-guest-handoff-policy.js',
    payment_truth_guard: 'scripts/lib/luna-guest-cami-reply-author.js',
    service_capture: 'scripts/lib/luna-guest-service-transfer-explainer.js',
    transfer_capture: 'scripts/lib/luna-guest-service-transfer-explainer.js',
    post_booking_service_attach: 'scripts/lib/luna-guest-booking-disambiguation.js',
    greeting_intent_gate: 'scripts/lib/luna-guest-frontdesk-planner.js',
    whatsapp_spacing: 'scripts/lib/luna-guest-package-explainer.js',
    cami_voice: 'scripts/lib/luna-guest-cami-reply-author.js',
    reply_style_contract: 'scripts/lib/luna-guest-reply-style-contract.js',
    pipeline_debug: 'scripts/lib/luna-guest-reply-pipeline.js',
  };
  return map[fixType] || 'see docs/LUNA-GUEST-BEHAVIOR-SPEC.md owner column';
}

function buildVerifierAssertions(failures) {
  return failures.map((f) => ({
    turn_index: f.turn_index,
    category: f.category,
    assertion: `no_${f.category}_violation_at_turn_${f.turn_index}`,
    fix_type: f.recommended_fix_type,
  }));
}

/**
 * @param {object} input
 * @returns {object} coach report
 */
function evaluateLunaGuestTranscript(input) {
  const inp = input || {};
  const turns = normalizeTurns(inp.transcript);
  const ctx = {
    expected_context: inp.expected_context || {},
    booking_state: inp.booking_state || inp.expected_context || {},
    tool_results: inp.tool_results || [],
    stage_flags: inp.stage_flags || {},
    prior_replies: [],
  };

  const rollingFields = { ...(ctx.booking_state.extracted_fields || {}) };
  const allFailures = [];
  for (const turn of turns) {
    const inferred = inferFieldsFromGuestMessage(turn.guest_message, rollingFields);
    Object.assign(rollingFields, inferred);
    ctx.booking_state = { ...ctx.booking_state, extracted_fields: { ...rollingFields } };
    const turnFailures = evaluateTurn(turn, ctx);
    allFailures.push(...turnFailures);
    if (turn.luna_reply) ctx.prior_replies.push(turn.luna_reply);
  }

  for (const f of allFailures) {
    if (!FAILURE_CATEGORIES.has(f.category)) f.category = 'intent';
  }

  const overallScore = scoreFromFailures(allFailures);
  const shippingBlocker = isShippingBlocker(allFailures);

  return {
    overall_score: overallScore,
    shipping_blocker: shippingBlocker,
    failures: allFailures,
    regression_fixture_suggestion: {
      id: inp.fixture_id || 'coach-generated',
      turn_count: turns.length,
      guest_messages: turns.map((t) => t.guest_message).filter(Boolean),
    },
    minimal_fix_plan: buildMinimalFixPlan(allFailures),
    verifier_assertions: buildVerifierAssertions(allFailures),
    suggested_prompt_or_config_updates: buildMinimalFixPlan(allFailures).map((p) => ({
      target: p.owner_hint,
      note: p.summary,
    })),
    meta: {
      spec_loaded: loadBehaviorSpec(inp.luna_behavior_spec).length > 0,
      turn_count: turns.length,
      evaluator: 'deterministic',
    },
  };
}

module.exports = {
  evaluateLunaGuestTranscript,
  OLD_PACKAGE_ASK_RE,
  STALL_RE,
  HANDOFF_RE,
  SPEC_PATH,
};
