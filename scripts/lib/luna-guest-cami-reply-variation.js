'use strict';

/**
 * Stage 42a — Cami reply variation helper.
 *
 * Chooses Cami-style template variants deterministically per conversation turn.
 * Preserves business facts (amounts, dates) — only wording varies.
 */

function personalityHelpers() {
  return require('./luna-guest-personality-config');
}

const COMPOSER_STATE_POOL_KEYS = Object.freeze({
  greeting: 'welcome',
  ask_dates: 'ask_dates',
  confirm_dates: 'ask_guest_count',
  ask_guests: 'ask_guest_count',
  ask_guest_name: 'ask_guest_count',
  accommodation_quote_ready: 'quote_ready',
  package_quote_ready: 'quote_ready',
  ask_payment_choice: 'payment_choice_prompt',
  payment_choice_ack: 'payment_choice_prompt',
  answer_arrival_payment_question: 'cash_side_question',
  explain_transfer: 'transfer_side_question',
  reset_start_over: 'reset_start_over',
  correction_ack: 'correction_accepted',
  confirmation_intro: 'confirmation_intro',
  explain_surf_report: 'surf_report_fallback',
  explain_house_knowledge: 'faq_answer_tail',
  explain_service_addon: 'service_added',
  addons_declined: 'addons_declined',
});

const WELCOME_POOL_KEYS = Object.freeze({
  generic: 'welcome',
  booking_intent: 'welcome_booking_intent',
  info_only: 'welcome_info_only',
  returning: 'welcome_returning',
});

const OPENER_PATTERNS = [
  /^yesss[,\s!—-]*/i,
  /^heyyy[,\s!—-]*/i,
  /^hey[,\s!—-]*/i,
  /^perfect[,\s!—-]*/i,
  /^nice[,\s!—-]*/i,
  /^super[,\s!—-]*/i,
  /^got it[,\s!—-]*/i,
  /^holaaa[,\s!—-]*/i,
  /^ciaooo[,\s!—-]*/i,
  /^genial[,\s!—-]*/i,
];

const PAYMENT_PROMPT_PATTERNS = [
  /would you (?:rather|prefer).*deposit.*full/i,
  /pay the \{\{deposit\}\} deposit.*full \{\{total\}\}/i,
  /deposit now.*full \{\{total\}\}/i,
  /to hold the spot/i,
];

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function hashSeed(seedKey) {
  let h = 0;
  const s = String(seedKey || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function loadCamiBehavior(clientSlug) {
  const { resolveActivePersonality } = personalityHelpers();
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality || resolved.active_personality_id !== 'cami') {
    return null;
  }
  return resolved.personality.behavior || null;
}

function normalizeLang(lang) {
  const code = trimStr(lang).toLowerCase() || 'en';
  return code.slice(0, 2);
}

function getVariationPool(behavior, lang, poolKey) {
  if (!behavior || !behavior.variation_pools) return null;
  const pools = behavior.variation_pools;
  const code = normalizeLang(lang);
  const langPools = pools[code] || pools.en || null;
  if (!langPools) return null;
  const variants = langPools[poolKey];
  return Array.isArray(variants) && variants.length ? variants : null;
}

function extractOpener(text) {
  const line = trimStr(text).split('\n')[0] || '';
  for (const re of OPENER_PATTERNS) {
    const m = line.match(re);
    if (m) return m[0].replace(/[,\s!—-]+$/, '').toLowerCase();
  }
  const firstWord = line.split(/\s+/)[0];
  return firstWord ? firstWord.toLowerCase().replace(/[^\w]/g, '') : '';
}

function extractPaymentPromptSignature(text) {
  const t = trimStr(text).toLowerCase();
  if (/deposit.*full|full.*deposit/.test(t)) {
    if (/hold the spot/.test(t)) return 'hold_spot_deposit_full';
    if (/would you rather/.test(t)) return 'would_rather_deposit_full';
    return 'deposit_or_full';
  }
  return null;
}

function buildVariationContext(input) {
  const prior = (input && input.prior_guest_context) || {};
  const history = prior.cami_variation_history || {};
  return {
    seed: trimStr(input && input.variation_seed)
      || trimStr(prior.guest_phone)
      || trimStr(input && input.guest_phone)
      || 'wolfhouse-cami',
    turnIndex: Number(history.turn_count || 0),
    usedOpeners: Array.isArray(history.openers) ? history.openers.slice() : [],
    usedPaymentPrompts: Array.isArray(history.payment_prompts) ? history.payment_prompts.slice() : [],
    usedPhrases: Array.isArray(history.phrases) ? history.phrases.slice() : [],
    priorReplies: Array.isArray(history.replies) ? history.replies.slice(-5) : [],
  };
}

function pickCamiVariant(opts) {
  const o = opts || {};
  const variants = o.variants || [];
  if (!variants.length) return null;
  if (variants.length === 1) return variants[0];

  const usedOpeners = o.usedOpeners || [];
  const usedPaymentPrompts = o.usedPaymentPrompts || [];
  const poolKey = o.poolKey || 'default';
  const baseSeed = `${o.seed || 'cami'}:${poolKey}:${o.turnIndex || 0}:${o.lang || 'en'}`;

  const candidates = [];
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const { interpolateTemplate } = personalityHelpers();
    const opener = extractOpener(interpolateTemplate(variant, o.vars || {}) || variant);
    const paySig = extractPaymentPromptSignature(variant);
    let skip = false;
    if (o.avoidOpenerRepeat && opener && usedOpeners.includes(opener)) skip = true;
    if (o.avoidPaymentPromptRepeat && paySig && usedPaymentPrompts.includes(paySig)) skip = true;
    if (!skip) candidates.push({ variant, index: i, opener, paySig });
  }

  const pool = candidates.length ? candidates : variants.map((variant, index) => ({
    variant,
    index,
    opener: extractOpener(variant),
    paySig: extractPaymentPromptSignature(variant),
  }));

  const pick = pool[hashSeed(baseSeed) % pool.length];
  return pick ? pick.variant : variants[0];
}

function resolveCamiTemplate(clientSlug, lang, poolKey, baseTemplate, vars, variationCtx) {
  const { interpolateTemplate } = personalityHelpers();
  const behavior = loadCamiBehavior(clientSlug);
  const variants = getVariationPool(behavior, lang, poolKey);
  if (variants) {
    const picked = pickCamiVariant({
      variants,
      seed: variationCtx && variationCtx.seed,
      turnIndex: variationCtx && variationCtx.turnIndex,
      lang,
      poolKey,
      vars,
      usedOpeners: variationCtx && variationCtx.usedOpeners,
      usedPaymentPrompts: variationCtx && variationCtx.usedPaymentPrompts,
      avoidOpenerRepeat: !!(behavior && behavior.core_patterns && behavior.core_patterns.avoid_yesss_opener_streak !== false),
      avoidPaymentPromptRepeat: !!(behavior && behavior.core_patterns && behavior.core_patterns.avoid_same_payment_prompt_wording !== false),
    });
    if (picked) return interpolateTemplate(picked, vars);
  }
  return interpolateTemplate(baseTemplate, vars);
}

function resolveCamiTemplateForComposerState(clientSlug, lang, composerState, templateKey, baseTemplate, vars, variationCtx) {
  const poolKey = COMPOSER_STATE_POOL_KEYS[composerState] || templateKey;
  return resolveCamiTemplate(clientSlug, lang, poolKey, baseTemplate, vars, variationCtx);
}

function resolveCamiWelcomeTemplate(clientSlug, lang, welcomeKind, baseTemplate, vars, variationCtx) {
  const poolKey = WELCOME_POOL_KEYS[welcomeKind] || WELCOME_POOL_KEYS.generic;
  return resolveCamiTemplate(clientSlug, lang, poolKey, baseTemplate, vars, variationCtx);
}

function recordCamiPhraseUsage(history, reply, composerState) {
  const h = history && typeof history === 'object' ? { ...history } : {};
  const text = trimStr(reply);
  if (!text) return h;

  const openers = Array.isArray(h.openers) ? h.openers.slice() : [];
  const paymentPrompts = Array.isArray(h.payment_prompts) ? h.payment_prompts.slice() : [];
  const phrases = Array.isArray(h.phrases) ? h.phrases.slice() : [];
  const replies = Array.isArray(h.replies) ? h.replies.slice() : [];

  const opener = extractOpener(text);
  if (opener && !openers.includes(opener)) openers.push(opener);
  if (openers.length > 8) openers.splice(0, openers.length - 8);

  const paySig = extractPaymentPromptSignature(text);
  if (paySig && !paymentPrompts.includes(paySig)) paymentPrompts.push(paySig);
  if (paymentPrompts.length > 6) paymentPrompts.splice(0, paymentPrompts.length - 6);

  const snippet = text.slice(0, 80).toLowerCase();
  if (snippet && !phrases.includes(snippet)) phrases.push(snippet);
  if (phrases.length > 10) phrases.splice(0, phrases.length - 10);

  replies.push(text);
  if (replies.length > 6) replies.shift();

  return {
    turn_count: Number(h.turn_count || 0) + 1,
    last_composer_state: composerState || h.last_composer_state || null,
    openers,
    payment_prompts: paymentPrompts,
    phrases,
    replies,
  };
}

function applyCamiReplyVariation(reply, opts) {
  const text = trimStr(reply);
  if (!text) return text;
  const clientSlug = opts && opts.clientSlug;
  const behavior = loadCamiBehavior(clientSlug);
  if (!behavior) return text;

  let out = text;
  const rules = behavior.core_patterns || {};
  const variationCtx = opts && opts.variationCtx;

  if (rules.avoid_yesss_opener_streak && variationCtx && variationCtx.usedOpeners.includes('yesss')) {
    if (/^yesss/i.test(out)) {
      out = out.replace(/^yesss[,\s!—-]*/i, 'Good news — ');
    }
  }

  if (rules.max_emoji_density != null) {
    const emojis = out.match(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu) || [];
    const max = Number(rules.max_emoji_density) || 3;
    if (emojis.length > max) {
      let count = 0;
      out = out.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, (m) => {
        count += 1;
        return count <= max ? m : '';
      }).replace(/\s{2,}/g, ' ').trim();
    }
  }

  return out;
}

function mergeVariationHistoryIntoGuestContext(guestContext, history) {
  if (!history) return guestContext;
  const gc = guestContext && typeof guestContext === 'object' ? { ...guestContext } : {};
  gc.cami_variation_history = history;
  return gc;
}

module.exports = {
  COMPOSER_STATE_POOL_KEYS,
  WELCOME_POOL_KEYS,
  loadCamiBehavior,
  getVariationPool,
  extractOpener,
  extractPaymentPromptSignature,
  buildVariationContext,
  pickCamiVariant,
  resolveCamiTemplate,
  resolveCamiTemplateForComposerState,
  resolveCamiWelcomeTemplate,
  recordCamiPhraseUsage,
  applyCamiReplyVariation,
  mergeVariationHistoryIntoGuestContext,
  hashSeed,
};
