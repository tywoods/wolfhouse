'use strict';

/**
 * Stage 41a — Wolfhouse/Somo guest knowledge config loader + FAQ reply helper.
 * Grounded facts only; no booking mutations, no actions, no live surf API.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
const CACHE = new Map();
const DEFAULT_CLIENT = 'wolfhouse-somo';
const GATE_CODE_RE = /\b2684\s*#?\b/i;

const INTENT_PATTERNS = [
  { id: 'gate_code', re: /\b(?:gate\s+code|door\s+code|access\s+code|entry\s+code|what\s+is\s+the\s+code)\b/i },
  { id: 'location', re: /\b(?:where\s+(?:is|are)\s+(?:wolfhouse|the\s+house|you)|how\s+far\s+(?:from\s+)?(?:the\s+)?beach|find\s+you|wolfhouse\s+location)\b/i },
  { id: 'location', re: /\b(?:location|address)\b/i },
  { id: 'towels_sheets', re: /\b(?:towel|towels|sheets|linen|bedding)\b/i },
  { id: 'packing', re: /\b(?:what\s+(?:should|do)\s+i\s+bring|what\s+to\s+bring|packing\s+list)\b/i },
  { id: 'wetsuit_info', re: /\b(?:do\s+i\s+need\s+(?:a\s+)?wetsuit|should\s+i\s+bring\s+(?:a\s+)?wetsuit|need\s+(?:a\s+)?wetsuit|wetsuit\s+thickness)\b/i },
  { id: 'lesson_times', re: /\b(?:what\s+time\s+(?:are|is)\s+(?:the\s+)?surf\s+lessons?|when\s+are\s+(?:the\s+)?(?:surf\s+)?lessons?|lesson\s+times?|surf\s+lesson\s+schedule)\b/i },
  { id: 'transfer_how', re: /\b(?:how\s+(?:does|do)\s+(?:the\s+)?(?:airport\s+)?transfer(?:s)?\s+work|how\s+(?:does|do)\s+transfers?\s+work)\b/i },
  { id: 'payments_info', re: /\b(?:how\s+(?:can|do)\s+i\s+pay|how\s+do\s+payments?\s+work|payment\s+methods?|pay\s+on\s+arrival)\b/i },
  { id: 'yoga_meals_info', re: /\b(?:how\s+(?:does|do)\s+(?:yoga|dinners?|meals?)\s+work|when\s+is\s+(?:yoga|dinner|breakfast)|yoga\s+schedule|dinner\s+times?)\b/i },
  { id: 'board_care', re: /\b(?:what\s+(?:do|should)\s+i\s+do\s+with\s+(?:the\s+)?board|after\s+surfing|board\s+storage|rinse\s+(?:the\s+)?board|board\s+care|where\s+(?:do|should)\s+i\s+put\s+(?:the\s+)?board)\b/i },
  { id: 'house_rules', re: /\b(?:house\s+rules|fridge\s+label|food\s+box)\b/i },
  { id: 'checkin_checkout', re: /\b(?:check[- ]?in\s+time|check[- ]?out\s+time|when\s+can\s+i\s+check[- ]?in)\b/i },
  { id: 'rentals_info', re: /\b(?:rent\s+(?:a\s+)?(?:board|wetsuit|surfboard)|hire\s+(?:a\s+)?board|board\s+rental|can\s+i\s+rent)\b/i },
];

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function configPathForClient(clientSlug) {
  return path.join(CONFIG_DIR, `${trimStr(clientSlug) || DEFAULT_CLIENT}.knowledge.json`);
}

function loadKnowledgeConfig(clientSlug) {
  const slug = trimStr(clientSlug) || DEFAULT_CLIENT;
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

function findCategory(config, categoryId) {
  if (!config || !Array.isArray(config.categories)) return null;
  return config.categories.find((c) => c && c.id === categoryId) || null;
}

function canRevealPrivateBookingDetails(guestContext) {
  const ctx = guestContext || {};
  if (ctx.confirmation_sent === true) return true;
  if (ctx.confirmation_preview_ready === true) return true;
  if (ctx.booking_status === 'confirmed' || ctx.booking_confirmed === true) return true;
  if (ctx.payment_received === true && (ctx.booking_code || ctx.booking_id)) return true;
  const pt = ctx.payment_truth || ctx.live_payment_truth;
  if (pt && (pt.deposit_paid === true || pt.full_paid === true || pt.payment_received === true)) {
    return true;
  }
  const hold = ctx.hold_status || ctx.booking_hold_status;
  if (hold === 'active' && ctx.payment_received === true) return true;
  return false;
}

function isPrivateCategory(category) {
  return !!(category && String(category.visibility || '').toLowerCase() === 'private');
}

function keywordMatches(text, keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(String(text || ''));
}

function detectGuestKnowledgeIntent(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  for (const { id, re } of INTENT_PATTERNS) {
    if (re.test(t)) return id;
  }

  const lower = t.toLowerCase();
  const config = loadKnowledgeConfig(DEFAULT_CLIENT);
  if (config && Array.isArray(config.categories)) {
    for (const cat of config.categories) {
      if (!cat || !Array.isArray(cat.keywords)) continue;
      if (cat.keywords.some((kw) => keywordMatches(t, kw))) {
        return cat.id;
      }
    }
  }
  return null;
}

function shouldPrioritizeKnowledgeOverService(text, intent) {
  const t = String(text || '');
  const informational = [
    'location', 'towels_sheets', 'packing', 'lesson_times', 'board_care',
    'gate_code', 'house_rules', 'checkin_checkout', 'transfer_how',
    'payments_info', 'yoga_meals_info',
  ];
  if (informational.includes(intent)) {
    if (intent === 'payments_info') {
      try {
        const { detectPaymentChoiceFromMessage } = require('./luna-guest-payment-choice-dry-run');
        if (detectPaymentChoiceFromMessage(t)) return false;
      } catch (_) { /* noop */ }
    }
    if (intent === 'transfer_how') {
      try {
        const { isPaymentMethodTransferQuestion } = require('./luna-guest-service-transfer-explainer');
        if (typeof isPaymentMethodTransferQuestion === 'function' && isPaymentMethodTransferQuestion(t)) {
          return false;
        }
      } catch (_) { /* noop */ }
      if (!/\bhow\b/i.test(t)) return false;
    }
    if (intent === 'yoga_meals_info' && /\b(?:add|book|request|añadir|aggiung)\b/i.test(t)) {
      return false;
    }
    return true;
  }
  if (intent === 'wetsuit_info') {
    return /\b(?:do\s+i\s+need|should\s+i\s+bring|need\s+(?:a\s+)?wetsuit|brauche\s+ich|necesito|ho\s+bisogno)\b/i.test(t);
  }
  if (intent === 'rentals_info') {
    return /\b(?:do\s+i\s+need|should\s+i\s+bring)\b/i.test(t);
  }
  return false;
}

function interpolateTemplate(template, vars) {
  if (!template) return null;
  let out = template;
  for (const [key, value] of Object.entries(vars || {})) {
    if (value == null || value === '') continue;
    out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
  }
  return out.replace(/\{\{[a-z_]+\}\}/g, '').trim();
}

function buildMidFlowKnowledgeReturnTail(fields, quote, pc) {
  const { quoteAwaitingAddonsDecision } = require('./luna-booking-addons-policy');
  const checkIn = trimStr(fields && fields.check_in);
  const checkOut = trimStr(fields && fields.check_out);
  const guests = fields && fields.guest_count != null ? Number(fields.guest_count) : null;

  if (quote && quote.quote_status === 'ready') {
    if (quoteAwaitingAddonsDecision(quote)) {
      return 'Are you going to need a wetsuit, surfboard, and/or lessons, or just the stay?';
    }
    if (pc && pc.payment_choice_needed === true) {
      return 'Want to pay the deposit or the full amount to hold the spot?';
    }
    return 'Want me to keep going with your booking?';
  }

  if (checkIn && checkOut && guests != null) {
    return 'Want me to keep going with your booking?';
  }
  if (checkIn && checkOut) {
    return 'How many guests is it for?';
  }
  return null;
}

/**
 * Build a grounded FAQ reply from client knowledge config.
 *
 * @returns {{ reply: string|null, category: string|null, visibility: string, allowed_guest_answer: boolean, requires_staff_confirmation: boolean }}
 */
function buildGuestKnowledgeReply(input) {
  const inp = input || {};
  const clientSlug = trimStr(inp.client_slug) || DEFAULT_CLIENT;
  const lang = trimStr(inp.lang).slice(0, 2) || 'en';
  const categoryId = trimStr(inp.category_id) || detectGuestKnowledgeIntent(inp.message_text);
  const guestContext = inp.guest_context || inp.prior_guest_context || {};
  const fields = inp.fields || {};
  const quote = inp.quote || guestContext.quote || null;
  const pc = inp.payment_choice || guestContext.payment_choice || null;
  const preserveContext = inp.preserve_booking_context !== false;

  if (!categoryId) {
    return {
      reply: null,
      category: null,
      visibility: null,
      allowed_guest_answer: false,
      requires_staff_confirmation: false,
    };
  }

  const config = loadKnowledgeConfig(clientSlug);
  const category = findCategory(config, categoryId);
  if (!category) {
    return {
      reply: null,
      category: categoryId,
      visibility: null,
      allowed_guest_answer: false,
      requires_staff_confirmation: false,
    };
  }

  if (isPrivateCategory(category) && !canRevealPrivateBookingDetails(guestContext)) {
    const tpl = (category.templates && (category.templates[`${lang}_private`] || category.templates.en))
      || (category.templates && category.templates.en)
      || null;
    let reply = tpl || 'That detail is shared once your booking is confirmed 🔒';
    if (GATE_CODE_RE.test(reply)) reply = category.templates.en;
    const tail = preserveContext ? buildMidFlowKnowledgeReturnTail(fields, quote, pc) : null;
    if (tail) reply = `${reply} ${tail}`;
    return {
      reply,
      category: categoryId,
      visibility: 'private',
      allowed_guest_answer: false,
      requires_staff_confirmation: true,
    };
  }

  const mapsLink = (config && config.maps_link) || '';
  const templateKey = canRevealPrivateBookingDetails(guestContext) && category.templates && category.templates[`${lang}_confirmed`]
    ? `${lang}_confirmed`
    : lang;
  const template = (category.templates && (category.templates[templateKey] || category.templates.en)) || null;
  let reply = interpolateTemplate(template, { maps_link: mapsLink });
  if (!reply) {
    reply = trimStr(config && config.escalation_default) || 'The team will confirm the exact details with you.';
  }

  if (GATE_CODE_RE.test(reply) && !canRevealPrivateBookingDetails(guestContext)) {
    reply = (category.templates && category.templates.en)
      || 'The gate code comes with your confirmed booking/check-in info once the stay is locked in 🔒';
  }

  const tail = preserveContext ? buildMidFlowKnowledgeReturnTail(fields, quote, pc) : null;
  if (tail) reply = `${reply} ${tail}`;

  return {
    reply,
    category: categoryId,
    visibility: category.visibility || 'public',
    allowed_guest_answer: category.allowed_guest_answer !== false,
    requires_staff_confirmation: category.requires_staff_confirmation === true,
  };
}

function listKnowledgeCategories(clientSlug) {
  const config = loadKnowledgeConfig(clientSlug);
  if (!config || !Array.isArray(config.categories)) return [];
  return config.categories.map((c) => c.id).filter(Boolean);
}

function knowledgeConfigHasMapsLink(clientSlug) {
  const config = loadKnowledgeConfig(clientSlug);
  return !!(config && trimStr(config.maps_link).includes('maps.app.goo.gl'));
}

module.exports = {
  loadKnowledgeConfig,
  detectGuestKnowledgeIntent,
  shouldPrioritizeKnowledgeOverService,
  canRevealPrivateBookingDetails,
  buildGuestKnowledgeReply,
  buildMidFlowKnowledgeReturnTail,
  listKnowledgeCategories,
  knowledgeConfigHasMapsLink,
  isPrivateCategory,
  DEFAULT_CLIENT,
};
