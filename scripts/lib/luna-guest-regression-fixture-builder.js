'use strict';

/**
 * Build a golden-fixture skeleton from a coach report + transcript.
 */

const { OLD_PACKAGE_ASK_RE, STALL_RE } = require('./luna-guest-coach-evaluator');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function slugify(text) {
  return String(text || 'coach-case')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'coach-case';
}

function forbiddenFromFailure(failure) {
  const reply = failure.luna_reply || '';
  const phrases = [];
  if (OLD_PACKAGE_ASK_RE.test(reply)) {
    phrases.push('Are you looking for a surf package like Malibu, or just accommodation');
    phrases.push('Malibu or accommodation');
  }
  if (STALL_RE.test(reply)) {
    phrases.push('I can look into availability');
    phrases.push('let me look into the best option');
  }
  if (/€\s*\d+/i.test(reply) && failure.category === 'copy') {
    phrases.push('€');
  }
  if (failure.actual_behavior && failure.actual_behavior.length < 80) {
    const snippet = reply.split('\n')[0].slice(0, 60).trim();
    if (snippet.length > 10) phrases.push(snippet);
  }
  return phrases.filter(Boolean);
}

function expectForFailure(failure) {
  const expect = {
    no_internal_language: true,
    expected_no_handoff: failure.category !== 'handoff',
  };

  if (failure.category === 'truth') expect.no_fake_confirmation = true;
  if (failure.category === 'booking_progress' && failure.recommended_fix_type === 'package_explainer_before_choice') {
    expect.reply_not_contains = [
      'Are you looking for a surf package like Malibu, or just accommodation',
      'Malibu or accommodation',
    ];
  }
  if (failure.category === 'booking_progress' && failure.recommended_fix_type === 'quote_payment_progression') {
    expect.reply_not_contains = ['I can look into availability', 'let me look into the best option'];
    expect.expected_quote_ready = true;
  }
  if (failure.category === 'services') {
    expect.reply_contains = failure.guest_message.match(/yoga/i) ? ['yoga'] : ['board', 'wetsuit', 'transfer', 'lesson'].filter(
      (w) => new RegExp(w, 'i').test(failure.guest_message),
    );
    expect.allow_partial = true;
  }
  if (failure.category === 'formatting') {
    expect.min_cami_score = 40;
    expect.allow_partial = true;
  }
  if (failure.category === 'copy' && failure.recommended_fix_type === 'greeting_intent_gate') {
    expect.reply_not_contains = ['€', 'Malibu'];
    expect.allow_partial = true;
  }

  const forbidden = forbiddenFromFailure(failure);
  if (forbidden.length) {
    expect.reply_not_contains = [...(expect.reply_not_contains || []), ...forbidden];
  }

  return expect;
}

/**
 * @param {object} args
 * @param {Array} args.transcript
 * @param {object} [args.coach_report]
 * @param {string} [args.id]
 * @param {string} [args.label]
 * @param {string} [args.reference_date]
 * @param {string[]} [args.spec_refs]
 */
function buildRegressionFixtureSkeleton(args) {
  const a = args || {};
  const transcript = a.transcript || [];
  const report = a.coach_report || {};
  const failures = report.failures || [];

  const failureByTurn = new Map();
  for (const f of failures) {
    if (!failureByTurn.has(f.turn_index)) failureByTurn.set(f.turn_index, []);
    failureByTurn.get(f.turn_index).push(f);
  }

  const turns = transcript.map((t, i) => {
    const guest = trimStr(t.guest || t.guest_message || t.message || (typeof t === 'string' ? t : ''));
    const turnFailures = failureByTurn.get(i) || [];
    const expect = turnFailures.length
      ? expectForFailure(turnFailures[0])
      : { no_internal_language: true, expected_no_handoff: true };

    const out = { message: guest, expect };
    if (t.inject_guest_context) out.inject_guest_context = t.inject_guest_context;
    return out;
  });

  const id = a.id || `coach-${slugify(a.label || turns[0] && turns[0].message)}`;
  const specRefs = a.spec_refs || failures.map((f) => f.category).filter((c, idx, arr) => arr.indexOf(c) === idx);

  return {
    id,
    label: a.label || `Coach seed: ${id}`,
    spec_refs: specRefs,
    reference_date: a.reference_date || '2026-06-10',
    coach_generated: true,
    forbidden_replies: failures.flatMap((f) => forbiddenFromFailure(f)).filter((p, idx, arr) => arr.indexOf(p) === idx),
    required_reply_qualities: report.minimal_fix_plan || [],
    turns,
    final_expect: {
      no_handoff: !failures.some((f) => f.category === 'handoff'),
      no_internal_language: true,
    },
  };
}

module.exports = {
  buildRegressionFixtureSkeleton,
  forbiddenFromFailure,
};
