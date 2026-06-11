'use strict';

/**
 * Stage 37a — attachable Luna personality config loader.
 *
 * Personalities control guest-facing wording only. Business facts (price, availability,
 * payment status, booking code, etc.) remain code-owned in the reply composer.
 */

const fs = require('fs');
const path = require('path');

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
function buildPersonalityReplyLexicon(clientSlug, lang, formatters) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality || resolved.active_personality_id === 'luna_safe') {
    return null;
  }

  const tpl = pickLangTemplates(resolved.personality, lang);
  if (!tpl) return null;

  const fmt = formatters || {};
  const introShort = tpl.intro_short
    || `Hey! I'm ${resolved.assistant_name} from Wolfhouse 🌊`;

  function t(key, vars) {
    const base = tpl[key];
    if (!base) return null;
    return interpolateTemplate(base, { intro_short: introShort, ...(vars || {}) });
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
        const head = t('accommodation_quote_available', { total, range, guests });
        if (head) parts.push(head);
        else parts.push(`Yesss, good news — we have space for those dates ☀️ The stay comes to ${total}.`);
      } else {
        parts.push(`The stay comes to ${total}.`);
      }
      const tail = t('accommodation_quote_addons_tail') || 'Do you need a wetsuit, board, or lessons too, or just the stay?';
      parts.push(tail);
      return parts.join('\n\n');
    },
    package_quote: (ctx) => {
      const { total, deposit, packageLabel, dateAvail, awaitingAddons } = ctx;
      if (!total) return null;
      const parts = [];
      const head = t('package_quote_available', {
        total,
        package_label: packageLabel,
        date_avail: dateAvail,
      });
      if (head) parts.push(head);
      if (awaitingAddons) {
        const tail = t('accommodation_quote_addons_tail') || 'Do you need a wetsuit, board, or lessons too, or just the stay?';
        parts.push(tail);
        return parts.join('\n\n');
      }
      const payTail = t('package_quote_payment_tail', { deposit, total })
        || `Would you rather pay the ${deposit} deposit or the full ${total}?`;
      parts.push(payTail);
      return parts.join('\n\n');
    },
    ask_payment_choice: (ctx) => {
      const { deposit, total, hasCollectedAddons, manualNote } = ctx;
      if (!deposit || !total) return null;
      const note = manualNote || '';
      if (hasCollectedAddons) {
        return (t('ask_payment_choice_with_extras', { deposit, total }) || `Got it — I've noted those extras 😊${note}\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`);
      }
      return (t('ask_payment_choice_accommodation_only', { deposit, total }) || `Perfect — just the stay then 😊${note}\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`);
    },
    answer_arrival_payment_question: (ctx) => {
      const { deposit, total } = ctx;
      if (!deposit || !total) {
        return t('answer_arrival_payment_question_no_amounts')
          || 'Yes — the rest can be paid on arrival by cash, bank transfer, or Stripe 😊 To hold the spot, we still need a deposit or full payment now.';
      }
      return t('answer_arrival_payment_question', { deposit, total })
        || `Yes — the rest can be paid on arrival by cash, bank transfer, or Stripe 😊 To hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
    },
    addons_none: (ctx) => {
      const { deposit, total } = ctx;
      if (!deposit || !total) return null;
      return t('addons_none', { deposit, total })
        || `Perfect — just the stay then 😊\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
    },
    deposit_ack: t('deposit_ack') || null,
    full_ack: t('full_ack') || null,
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

function buildWelcomeReply(clientSlug, lang, ctx) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality || resolved.active_personality_id === 'luna_safe') {
    return null;
  }

  const tpl = pickLangTemplates(resolved.personality, lang);
  if (!tpl) return null;

  const introShort = tpl.intro_short
    || `Heyyy! I'm ${resolved.assistant_name} from Wolfhouse 🌊 So happy you're here!`;
  const c = ctx || {};

  if (c.bookingInProgress && c.hasPriorContext) {
    return interpolateTemplate(tpl.greeting_returning || tpl.greeting, { intro_short: introShort })
      || 'Hey again! 🌊 Still here for you — want to keep going with your booking or start fresh?';
  }
  if (c.bookingIntent) {
    return interpolateTemplate(tpl.greeting_booking_intent || tpl.greeting, { intro_short: introShort })
      || 'Yesss, love that 🌊 What dates are you thinking for check-in and check-out?';
  }
  if (c.infoOnlyIntent) {
    return interpolateTemplate(tpl.greeting_info_only || tpl.greeting, { intro_short: introShort })
      || `${introShort}\nHappy to help with packages, surf, or anything about Somo — what would you like to know?`;
  }
  return interpolateTemplate(tpl.greeting_generic || tpl.greeting, { intro_short: introShort })
    || `${introShort}\nAre you looking to book a stay, ask about packages, or just check some info?`;
}

function buildPersonalityResetReply(clientSlug, lang) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality) return null;
  const tpl = pickLangTemplates(resolved.personality, lang);
  if (tpl && tpl.reset_start_over) {
    return interpolateTemplate(tpl.reset_start_over, {
      intro_short: tpl.intro_short || '',
    });
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
  getPersonalityBannedPhrases,
  personalityAffectsCopyOnlySummary,
  clearPersonalityConfigCache,
  interpolateTemplate,
  pickLangTemplates,
};
