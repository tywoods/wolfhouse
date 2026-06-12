'use strict';

/**
 * Stage 37a — attachable Luna personality config loader.
 *
 * Personalities control guest-facing wording only. Business facts (price, availability,
 * payment status, booking code, etc.) remain code-owned in the reply composer.
 */

const fs = require('fs');
const path = require('path');
const {
  buildVariationContext,
  resolveCamiTemplate,
  resolveCamiWelcomeTemplate,
} = require('./luna-guest-cami-reply-variation');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
const CACHE = new Map();

const DEFAULT_CLIENT = 'wolfhouse-somo';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function configPathForClient(clientSlug) {
  return path.join(CONFIG_DIR, `${trimStr(clientSlug)}.personalities.json`);
}

function loadClientPersonalityFile(clientSlug) {
  const slug = trimStr(clientSlug);
  if (!slug) {
    return null;
  }
  if (CACHE.has(slug)) return CACHE.get(slug);

  const filePath = configPathForClient(slug);
  if (!fs.existsSync(filePath)) {
    CACHE.set(slug, null);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    CACHE.set(slug, null);
    return null;
  }
  CACHE.set(slug, parsed);
  return parsed;
}

function resolveActivePersonality(clientSlug) {
  const file = loadClientPersonalityFile(clientSlug);
  if (!file) {
    return {
      client_slug: trimStr(clientSlug) || DEFAULT_CLIENT,
      assistant_name: 'Luna',
      active_personality_id: 'luna_safe',
      personality: null,
      config: null,
    };
  }

  const activeId = trimStr(file.active_personality) || trimStr(file.default_personality_id) || 'luna_safe';
  const personalities = file.personalities && typeof file.personalities === 'object'
    ? file.personalities
    : {};
  const personality = personalities[activeId] || null;

  return {
    client_slug: trimStr(file.source_client) || trimStr(clientSlug) || DEFAULT_CLIENT,
    assistant_name: trimStr(file.assistant_name) || 'Luna',
    active_personality_id: activeId,
    personality,
    config: file,
  };
}

function pickLangTemplates(personality, lang) {
  if (!personality || !personality.reply_templates) return null;
  const templates = personality.reply_templates;
  const code = trimStr(lang).toLowerCase() || 'en';
  return templates[code] || templates.en || null;
}

function interpolateTemplate(template, vars) {
  if (!template) return null;
  let out = template;
  const merged = { ...(vars || {}) };
  if (merged.intro_short && out.includes('{{intro_short}}')) {
    out = out.replace(/\{\{intro_short\}\}/g, merged.intro_short);
  }
  for (const [key, value] of Object.entries(merged)) {
    if (value == null || value === '') continue;
    out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
  }
  return out.replace(/\{\{[a-z_]+\}\}/g, '').replace(/\s+\n/g, '\n').trim();
}

/**
 * Build composer lexicon hooks for a client/lang. Returns null → use default safe Luna copy.
 */
function buildPersonalityReplyLexicon(clientSlug, lang, formatters, variationInput) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality || resolved.active_personality_id === 'luna_safe') {
    return null;
  }

  const tpl = pickLangTemplates(resolved.personality, lang);
  if (!tpl) return null;

  const fmt = formatters || {};
  const variationCtx = buildVariationContext(variationInput || {});
  const introShort = tpl.intro_short
    || `I'm ${resolved.assistant_name} from Wolfhouse`;

  function t(key, vars, poolKey) {
    const base = tpl[key];
    if (!base && !poolKey) return null;
    return resolveCamiTemplate(
      clientSlug,
      lang,
      poolKey || key,
      base,
      { intro_short: introShort, ...(vars || {}) },
      variationCtx,
    );
  }

  return {
    personality_id: resolved.active_personality_id,
    assistant_name: resolved.assistant_name,
    greeting: t('greeting') || `${introShort}\nAre you looking to book a stay, or just checking some info?`,
    ask_dates: t('ask_dates') || null,
    ask_dates_mid: t('ask_dates_mid') || t('ask_dates') || null,
    confirm_dates: (range) => t('confirm_dates', { range }) || null,
    ask_guests: (range) => t('ask_guests', { range }) || t('confirm_dates', { range }) || null,
    ask_guest_name: (range) => t('ask_guest_name', { range }) || null,
    accommodation_quote: (ctx) => {
      const { total, range, guests, availOk } = ctx;
      if (!total) return null;
      const parts = [];
      if (availOk !== false) {
        const head = t('accommodation_quote_available', { total, range, guests }, 'quote_ready');
        if (head) parts.push(head);
        else parts.push(`Yesss, good news — we have space for those dates ☀️ The stay comes to ${total}.`);
      } else {
        parts.push(`The stay comes to ${total}.`);
      }
      const tail = t('accommodation_quote_addons_tail', {}, 'addons_question')
        || 'Do you need a wetsuit, board, or lessons too, or just the stay?';
      parts.push(tail);
      return parts.join('\n\n');
    },
    package_quote: (ctx) => {
      const { total, deposit, packageLabel, dateAvail } = ctx;
      if (!total) return null;
      const parts = [];
      const head = t('package_quote_available', {
        total,
        package_label: packageLabel,
        date_avail: dateAvail,
      }, 'quote_ready');
      if (head) parts.push(head);
      const payTailRaw = t('package_quote_payment_tail', { deposit, total }, 'payment_choice_prompt')
        || `To reserve it, you can pay the ${deposit} deposit or the full ${total}.`;
      const payTail = /lessons|rentals|later if you want|add later/i.test(payTailRaw)
        ? payTailRaw
        : `${payTailRaw.replace(/\s+$/, '')} We can always add lessons or rentals later if you want.`;
      parts.push(payTail);
      return parts.join('\n\n');
    },
    ask_payment_choice: (ctx) => {
      const { deposit, total, hasCollectedAddons, manualNote } = ctx;
      if (!deposit || !total) return null;
      const note = manualNote || '';
      if (hasCollectedAddons) {
        return (t('ask_payment_choice_with_extras', { deposit, total }, 'service_added')
          || `Got it — I've noted those extras 😊${note}\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`);
      }
      return (t('ask_payment_choice_accommodation_only', { deposit, total }, 'addons_declined')
        || `Perfect — just the stay then 😊${note}\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`);
    },
    answer_arrival_payment_question: (ctx) => {
      const { deposit, total } = ctx;
      if (!deposit || !total) {
        return t('answer_arrival_payment_question_no_amounts', {}, 'pay_later_explainer')
          || 'Sure — balance on arrival by cash, bank transfer, or pay online works 😊 To hold the spot, we still need a deposit or full payment now.';
      }
      return t('answer_arrival_payment_question', { deposit, total }, 'cash_side_question')
        || `Sure — cash with me at check-in, or bank transfer on your arrival day. To hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
    },
    addons_none: (ctx) => {
      const { deposit, total } = ctx;
      if (!deposit || !total) return null;
      return t('addons_none', { deposit, total }, 'addons_declined')
        || `Perfect — just the stay then 😊\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
    },
    deposit_ack: (ctx) => t('deposit_ack', { deposit: ctx && ctx.deposit, total: ctx && ctx.total }, 'deposit_ack')
      || t('deposit_ack') || null,
    full_ack: (ctx) => t('full_ack', { deposit: ctx && ctx.deposit, total: ctx && ctx.total }, 'full_ack')
      || t('full_ack') || null,
    hold_no_link: (ctx) => {
      const { deposit } = ctx || {};
      if (!deposit) return null;
      return t('payment_link_pending', { deposit }, 'payment_link_pending')
        || `Your spot is held — our team will send your secure payment link here shortly for the ${deposit} deposit 👍`;
    },
    payment_link_failed: (ctx) => {
      const { deposit } = ctx || {};
      if (!deposit) return null;
      return t('payment_link_failed', { deposit }, 'payment_link_failed')
        || `No stress — I'm having a quick hiccup with the payment link. Our team will send your secure ${deposit} deposit link here shortly 👍`;
    },
    already_paid_check: () => t('already_paid_check', {}, 'already_paid_check')
      || "Thanks for letting me know — I can't confirm payment from chat alone. Our team will check and follow up with you 👍",
    pay_later_explainer: (ctx) => {
      const { deposit, total } = ctx || {};
      return t('pay_later_explainer', { deposit, total }, 'pay_later_explainer')
        || 'No stress — to hold the spot we need a deposit or full payment once your quote is ready. The rest you can pay on arrival 👍';
    },
    pay_why_now: (ctx) => {
      const { deposit, total } = ctx || {};
      return t('pay_why_now', { deposit, total }, 'pay_why_now')
        || `It's just to hold your spot while we get sorted — balance can be on arrival. ${deposit || 'deposit'} or full ${total || 'amount'}, whatever's easier 👍`;
    },
    stripe_link: (ctx) => {
      const { deposit, checkoutUrl } = ctx;
      if (!deposit || !checkoutUrl) return null;
      return t('stripe_link', { deposit, checkout_url: checkoutUrl })
        || `Perfect — your stay is held 🙌 You can pay the ${deposit} deposit here: ${checkoutUrl}\n\nOnce that's paid, your booking will be confirmed.`;
    },
    payment_link_sent: (ctx) => {
      const { deposit } = ctx;
      if (!deposit) return null;
      return t('payment_link_sent', { deposit })
        || `Perfect — your stay is held for the ${deposit} deposit 🙌 Check the secure payment link I just sent.`;
    },
    payment_received: (ctx) => {
      const { paid, balance } = ctx;
      if (!paid) return null;
      let msg = t('payment_received', { paid, balance })
        || `Got it — your ${paid} deposit is in 🙌 You're part of the Wolfhouse family`;
      if (balance && !/balance/i.test(msg)) {
        msg += `, and the remaining balance is ${balance}`;
      }
      if (!/confirmation/i.test(msg)) msg += '. I\'ll send your full confirmation next.';
      return msg;
    },
    confirmation_sent: t('confirmation_sent') || null,
    handoff: t('handoff') || null,
  };
}

function buildWelcomeReply(clientSlug, lang, ctx, variationInput) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality || resolved.active_personality_id === 'luna_safe') {
    return null;
  }

  const tpl = pickLangTemplates(resolved.personality, lang);
  if (!tpl) return null;

  const introShort = tpl.intro_short
    || `Heyyy! I'm ${resolved.assistant_name} from Wolfhouse 🌊 So happy you're here!`;
  const c = ctx || {};
  const variationCtx = buildVariationContext(variationInput || {});

  if (c.bookingInProgress && c.hasPriorContext) {
    return resolveCamiWelcomeTemplate(clientSlug, lang, 'returning', tpl.greeting_returning || tpl.greeting, { intro_short: introShort }, variationCtx)
      || 'Hey again! 🌊 Still here for you — want to keep going with your booking or start fresh?';
  }
  if (c.bookingIntent) {
    return resolveCamiWelcomeTemplate(clientSlug, lang, 'booking_intent', tpl.greeting_booking_intent || tpl.greeting, { intro_short: introShort }, variationCtx)
      || 'Yesss, love that 🌊 What dates are you thinking for check-in and check-out?';
  }
  if (c.infoOnlyIntent) {
    return resolveCamiWelcomeTemplate(clientSlug, lang, 'info_only', tpl.greeting_info_only || tpl.greeting, { intro_short: introShort }, variationCtx)
      || `${introShort}\nHappy to help with packages, surf, or anything about Somo — what would you like to know?`;
  }
  return resolveCamiWelcomeTemplate(clientSlug, lang, 'generic', tpl.greeting_generic || tpl.greeting, { intro_short: introShort }, variationCtx)
    || `${introShort}\nAre you looking to book a stay, ask about packages, or just check some info?`;
}

function paymentAmountsFromGuestCtx(guestCtx) {
  const quote = guestCtx && guestCtx.quote && typeof guestCtx.quote === 'object' ? guestCtx.quote : {};
  const fmt = (cents) => {
    if (cents == null || Number.isNaN(Number(cents))) return null;
    const euros = Number(cents) / 100;
    return `€${Number.isInteger(euros) ? euros : euros.toFixed(2)}`;
  };
  const total = fmt(quote.quote_total_cents);
  const depCents = quote.deposit_options && quote.deposit_options.deposit_required_cents;
  return { deposit: fmt(depCents), total };
}

/**
 * Cami wording for router-handled payment side questions (wording only — no payment truth changes).
 */
function buildPersonalityPaymentSideReply(clientSlug, lang, paymentKind, opts) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality || resolved.active_personality_id === 'luna_safe') {
    return null;
  }

  const o = opts || {};
  const guestCtx = o.guestCtx || {};
  const quoteReady = o.quoteReady === true;
  const { deposit, total } = paymentAmountsFromGuestCtx(guestCtx);
  const variationInput = {
    prior_guest_context: guestCtx,
    guest_phone: guestCtx.guest_phone || o.guest_phone,
  };
  const lex = buildPersonalityReplyLexicon(clientSlug, lang, null, variationInput);
  if (!lex) return null;

  const kind = paymentKind || 'unknown';

  if (kind === 'already_paid_claim') {
    return lex.already_paid_check ? lex.already_paid_check() : null;
  }

  if (kind === 'payment_failed') {
    return lex.payment_link_failed ? lex.payment_link_failed({ deposit }) : null;
  }

  if (kind === 'arrival_payment_question' || kind === 'pay_later') {
    if (quoteReady && deposit && total && lex.answer_arrival_payment_question) {
      return lex.answer_arrival_payment_question({ deposit, total });
    }
    return lex.pay_later_explainer ? lex.pay_later_explainer({ deposit, total }) : null;
  }

  if (kind === 'deposit_question') {
    if (quoteReady && deposit && total && lex.pay_why_now) {
      return lex.pay_why_now({ deposit, total });
    }
    return lex.pay_later_explainer ? lex.pay_later_explainer({ deposit, total }) : null;
  }

  return null;
}

function buildPersonalityResetReply(clientSlug, lang, variationInput) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality) return null;
  const tpl = pickLangTemplates(resolved.personality, lang);
  const variationCtx = buildVariationContext(variationInput || {});
  if (tpl && tpl.reset_start_over) {
    return resolveCamiTemplate(clientSlug, lang, 'reset_start_over', tpl.reset_start_over, {
      intro_short: tpl.intro_short || '',
    }, variationCtx);
  }
  const samples = resolved.personality.sample_replies;
  if (samples && samples.reset_start_over) {
    return samples.reset_start_over;
  }
  return null;
}

function getPersonalityBannedPhrases(clientSlug) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality || !Array.isArray(resolved.personality.banned_phrases)) {
    return [];
  }
  return resolved.personality.banned_phrases.slice();
}

function personalityAffectsCopyOnlySummary() {
  return 'Personality profiles control guest-facing wording only; price, availability, payment status, booking code, room, lesson time, surf report, and confirmation facts remain code-owned.';
}

function clearPersonalityConfigCache() {
  CACHE.clear();
}

module.exports = {
  DEFAULT_CLIENT,
  configPathForClient,
  loadClientPersonalityFile,
  resolveActivePersonality,
  buildPersonalityReplyLexicon,
  buildWelcomeReply,
  buildPersonalityResetReply,
  buildPersonalityPaymentSideReply,
  paymentAmountsFromGuestCtx,
  getPersonalityBannedPhrases,
  personalityAffectsCopyOnlySummary,
  clearPersonalityConfigCache,
  interpolateTemplate,
  pickLangTemplates,
};
