'use strict';

/**
 * Stage 42a — Deterministic Cami tone heuristic judge (tests/verifier only).
 */

const { findInternalLanguage } = require('./luna-fixture-expectations');
const { extractOpener, extractPaymentPromptSignature } = require('./luna-guest-cami-reply-variation');
const { isForbiddenGuestCopy } = require('./luna-guest-reply-style-contract');

const WARMTH_MARKERS = [
  /wolfhouse/i,
  /somo/i,
  /happy|glad|excited|welcome|family|familia|felice|alegr/i,
  /no stress|no worries|sort it|we(?:'|')?ll|team will|our team/i,
  /🌊|☀️|😊|🙌|💛|✨|🏄/,
];

const HUMAN_ENERGY_MARKERS = [
  /(?:!!|!!!)/,
  /hey+|super|nice|perfect|got it|love that|good news/i,
  /talk soon|see you|no stress at all|a domani/i,
  /volentieri|genial|ottime|bellissim/i,
];

const HONEST_HEDGE_MARKERS = [
  /\bi think\b/i,
  /\bshould be\b/i,
  /\bmore or less\b/i,
  /\bi(?:'|')?ll let you know\b/i,
  /\bdepends on\b/i,
];

const CLOSER_PRESENT_PATTERNS = [
  /\ba domani!?\b/i,
  /\btalk soon\b/i,
  /\bsee you soon\b/i,
  /\bun abbraccio\b/i,
  /\bbacioni\b/i,
  /\bgood night\b/i,
  /\bhere if you need\b/i,
  /\bcan't wait to welcome\b/i,
  /\bvi aspettiamo\b/i,
];

const ROBOTIC_PATTERNS = [
  /^great — i(?:'|')?ll check/i,
  /^i am not confirming/i,
  /orchestrator|quote_status|payment_choice|dry run|staging|internal/i,
  /please be advised|dear guest|kindly note|at your earliest convenience/i,
  /didn(?:'|')?t catch that/i,
];

const CORPORATE_PATTERNS = [
  /dear (?:guest|customer|sir|madam)/i,
  /please be advised/i,
  /at your earliest convenience/i,
  /we regret to inform/i,
  /policy states/i,
  /terms and conditions/i,
];

const FAKE_CERTAINTY_PATTERNS = [
  /\byou(?:'|')?re confirmed\b/i,
  /\bbooking is confirmed\b/i,
  /\byour booking is held\b/i,
  /\bpayment received\b/i,
  /\byou(?:'|')?ve paid\b/i,
  /\bi(?:'|')?ve confirmed\b/i,
];

const NEXT_STEP_PATTERNS = [
  /\?/,
  /\bwhat dates\b/i,
  /\bhow many guests\b/i,
  /\bwould you (?:rather|prefer)\b/i,
  /\bcould you share\b/i,
  /\bcan i grab\b/i,
  /\bdeposit or full\b/i,
  /\bwhen you(?:'|')?re ready\b/i,
  /\blet me know\b/i,
  /\bteam will\b/i,
  /\bfollow up\b/i,
  /\bshare (?:your )?flight\b/i,
  /\bsend me your flight\b/i,
];

const REFUSAL_MARKERS = [
  /\b(?:can(?:'|')?t|cannot|unable to)\b/i,
  /\b(?:don(?:'|')?t|do not) (?:do|offer)\b/i,
  /\bnot (?:available|possible)\b/i,
  /\b(?:impossible)\b/i,
  /\bwe don(?:'|')?t\b/i,
  /\busually don(?:'|')?t\b/i,
  /\bnot 100% sure\b/i,
  /\bnot sure yet\b/i,
];

const ALTERNATIVE_MARKERS = [
  /\bbut (?:we|I|you)\b/i,
  /\binstead\b/i,
  /\bwe(?:'|')?ll sort\b/i,
  /\bwe(?:'|')?ll check\b/i,
  /\bi(?:'|')?ll (?:check|let you know|organize)\b/i,
  /\b(?:easiest|best) option\b/i,
  /\bour team will\b/i,
  /\bno stress\b/i,
  /\bshare (?:your )?flight\b/i,
  /\bpick(?:\s|-)?(?:you\s-)?up\b/i,
  /\bwhat we can do\b/i,
  /\bask anytime\b/i,
];

function countEmojis(text) {
  const m = String(text || '').match(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu);
  return m ? m.length : 0;
}

function countQuestions(text) {
  return (String(text || '').match(/\?/g) || []).length;
}

function detectRepeatedPhrase(reply, priorReplies) {
  const current = String(reply || '').toLowerCase().slice(0, 60);
  if (!current || !Array.isArray(priorReplies)) return false;
  return priorReplies.some((p) => {
    const prior = String(p || '').toLowerCase().slice(0, 60);
    return prior && prior === current;
  });
}

function detectRepeatedOpener(reply, priorReplies) {
  const opener = extractOpener(reply);
  if (!opener || !Array.isArray(priorReplies)) return false;
  return priorReplies.some((p) => extractOpener(p) === opener);
}

function hasWarmth(text) {
  return WARMTH_MARKERS.some((re) => re.test(text));
}

function hasHumanEnergy(text) {
  return HUMAN_ENERGY_MARKERS.some((re) => re.test(text));
}

function hasHonestHedge(text) {
  return HONEST_HEDGE_MARKERS.some((re) => re.test(text));
}

function hasCloserPresent(text) {
  return CLOSER_PRESENT_PATTERNS.some((re) => re.test(text));
}

function hasRefusalLanguage(text) {
  return REFUSAL_MARKERS.some((re) => re.test(text));
}

function hasAlternativeLanguage(text) {
  if (ALTERNATIVE_MARKERS.some((re) => re.test(text))) return true;
  if (NEXT_STEP_PATTERNS.some((re) => re.test(text))) return true;
  if (hasHonestHedge(text) && /\b(?:check|sort|let you know|depends)\b/i.test(text)) return true;
  if (hasCloserPresent(text)) return true;
  return false;
}

function hasConstraintAlternative(text) {
  if (hasRefusalLanguage(text) && hasAlternativeLanguage(text)) return true;
  if (hasHonestHedge(text) && /\b(?:sort|check|let you know)\b/i.test(text)) return true;
  if (/\bno stress\b/i.test(text) && /\b(?:easiest|best) option\b/i.test(text)) return true;
  return false;
}

function hasBareRefusal(text) {
  if (!hasRefusalLanguage(text)) return false;
  return !hasAlternativeLanguage(text);
}

function suggestCategory(flags) {
  if (flags.includes('internal_language') || flags.includes('fake_confirmation')) return 'safety';
  if (flags.includes('robotic_opening') || flags.includes('too_corporate')) return 'robotic';
  if (flags.includes('repeated_phrase') || flags.includes('too_many_emojis')) return 'repetition';
  if (flags.includes('missing_next_step') || flags.includes('too_long') || flags.includes('bare_refusal')) return 'structure';
  if (flags.includes('no_warmth')) return 'warmth';
  return 'good';
}

/**
 * @param {string} reply
 * @param {object} [context]
 * @param {string[]} [context.priorReplies]
 * @param {boolean} [context.hasPaymentTruth]
 * @param {boolean} [context.paymentConfirmed]
 * @param {number} [context.minScore]
 * @returns {{ cami_score: number, flags: string[], suggested_category: string, details: object }}
 */
function judgeCamiTone(reply, context) {
  const text = String(reply || '').trim();
  const ctx = context || {};
  const flags = [];
  let score = 100;

  if (!text) {
    return {
      cami_score: 0,
      flags: ['missing_reply'],
      suggested_category: 'structure',
      details: { length: 0 },
    };
  }

  const len = text.length;
  const emojiCount = countEmojis(text);
  const questionCount = countQuestions(text);

  if (len > 900) {
    flags.push('too_long');
    score -= 25;
  } else if (len > 650) {
    score -= 10;
  }

  if (emojiCount > 4) {
    flags.push('too_many_emojis');
    score -= 15;
  } else if (emojiCount === 0 && len < 400 && !hasWarmth(text)) {
    score -= 5;
  }

  for (const re of ROBOTIC_PATTERNS) {
    if (re.test(text)) {
      flags.push('robotic_opening');
      score -= 20;
      break;
    }
  }

  for (const re of CORPORATE_PATTERNS) {
    if (re.test(text)) {
      flags.push('too_corporate');
      score -= 15;
      break;
    }
  }

  if (!hasWarmth(text) && !hasHumanEnergy(text) && !hasHonestHedge(text)) {
    flags.push('no_warmth');
    score -= 12;
  }

  const closerPresent = hasCloserPresent(text);
  const constraintAlternative = hasConstraintAlternative(text);
  if (questionCount === 0 && !NEXT_STEP_PATTERNS.some((re) => re.test(text)) && !closerPresent) {
    flags.push('missing_next_step');
    score -= 12;
  } else if (closerPresent && questionCount === 0) {
    score += 4;
  } else if (questionCount > 2) {
    score -= 8;
  }

  if (hasBareRefusal(text)) {
    flags.push('bare_refusal');
    score -= 18;
  } else if (constraintAlternative) {
    score += 5;
  }

  if (detectRepeatedPhrase(text, ctx.priorReplies)) {
    flags.push('repeated_phrase');
    score -= 18;
  }
  if (detectRepeatedOpener(text, ctx.priorReplies)) {
    flags.push('repeated_phrase');
    score -= 10;
  }

  const internal = findInternalLanguage(text);
  if (internal.length || isForbiddenGuestCopy(text)) {
    flags.push('internal_language');
    score -= 30;
  }

  const paymentTruth = ctx.hasPaymentTruth === true || ctx.paymentConfirmed === true;
  if (!paymentTruth) {
    for (const re of FAKE_CERTAINTY_PATTERNS) {
      if (re.test(text)) {
        flags.push('fake_confirmation');
        score -= 25;
        break;
      }
    }
  }

  if (extractPaymentPromptSignature(text) && Array.isArray(ctx.priorReplies)) {
    const priorSigs = ctx.priorReplies.map(extractPaymentPromptSignature).filter(Boolean);
    const sig = extractPaymentPromptSignature(text);
    if (sig && priorSigs.includes(sig)) {
      if (!flags.includes('repeated_phrase')) flags.push('repeated_phrase');
      score -= 8;
    }
  }

  score = Math.max(0, Math.min(100, score));
  const uniqueFlags = [...new Set(flags)];

  return {
    cami_score: score,
    flags: uniqueFlags,
    suggested_category: suggestCategory(uniqueFlags),
    details: {
      length: len,
      emoji_count: emojiCount,
      question_count: questionCount,
      opener: extractOpener(text),
      payment_prompt_sig: extractPaymentPromptSignature(text),
      closer_present: closerPresent,
      honest_hedge: hasHonestHedge(text),
      constraint_alternative: constraintAlternative,
      bare_refusal: hasBareRefusal(text),
    },
  };
}

function aggregateCamiScores(judgments) {
  const list = Array.isArray(judgments) ? judgments : [];
  if (!list.length) return { average: 0, min: 0, max: 0, count: 0 };
  const scores = list.map((j) => Number(j.cami_score || 0));
  const sum = scores.reduce((a, b) => a + b, 0);
  return {
    average: Math.round((sum / scores.length) * 10) / 10,
    min: Math.min(...scores),
    max: Math.max(...scores),
    count: scores.length,
  };
}

function topToneFlags(judgments, limit) {
  const counts = new Map();
  for (const j of judgments || []) {
    for (const f of j.flags || []) {
      counts.set(f, (counts.get(f) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit || 5)
    .map(([flag, count]) => ({ flag, count }));
}

module.exports = {
  judgeCamiTone,
  aggregateCamiScores,
  topToneFlags,
  WARMTH_MARKERS,
  HONEST_HEDGE_MARKERS,
  CLOSER_PRESENT_PATTERNS,
  ROBOTIC_PATTERNS,
  hasCloserPresent,
  hasHonestHedge,
  hasConstraintAlternative,
  hasBareRefusal,
};
