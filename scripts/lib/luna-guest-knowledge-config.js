'use strict';

/**
 * Stage 41a/41b — Wolfhouse/Somo guest knowledge config loader + multilingual FAQ helper.
 * Grounded facts only; no booking mutations, no actions, no live surf API.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
const CACHE = new Map();
const DEFAULT_CLIENT = 'wolfhouse-somo';
const GATE_CODE_RE = /\b2684\s*#?\b/i;

const CATEGORY_ALIASES = {
  yoga_meals_info: 'yoga_info',
  location_somo: 'location',
  surf_lessons: 'lesson_times',
  wetsuit_board: 'wetsuit_info',
  transfers: 'transfer_how',
  payments: 'payments_info',
};

const INTENT_PATTERNS = [
  { id: 'gate_code', re: /\b(?:gate\s+code|door\s+code|access\s+code|entry\s+code|codice\s+(?:del\s+)?cancello|c[oó]digo\s+(?:del\s+)?port[oó]n|torcode|torkode)\b/i },
  { id: 'location', re: /\b(?:where\s+(?:is|are)\s+(?:wolfhouse|the\s+house|you)|how\s+far\s+(?:from\s+)?(?:the\s+)?beach|find\s+you|wolfhouse\s+location|dove\s+(?:si\s+trova|siete|è)\s+(?:wolfhouse|la\s+casa)|d[oó]nde\s+(?:est[aá]|queda)\s+(?:wolfhouse|la\s+casa)|wo\s+ist\s+(?:wolfhouse|das\s+haus))\b/i },
  { id: 'location', re: /\b(?:location|address|ubicaci[oó]n|standort)\b/i },
  { id: 'towels_sheets', re: /\b(?:towel|towels|sheets|linen|bedding|asciugamani|lenzuola|toallas|s[aá]banas|handtuch|handt[uü]cher|bettw[aä]sche)\b/i },
  { id: 'towels_sheets', re: /\b(?:devo\s+portare\s+asciugamani|le\s+lenzuola\s+(?:sono\s+)?incluse|sind\s+bettw[aä]sche\s+dabei|brauche\s+ich\s+(?:ein\s+)?handtuch)\b/i },
  { id: 'packing', re: /\b(?:what\s+(?:should|do)\s+i\s+bring|what\s+to\s+bring|packing\s+list|cosa\s+devo\s+portare|qu[eé]\s+tengo\s+que\s+llevar|was\s+soll\s+ich\s+(?:mit)?bringen)\b/i },
  { id: 'wetsuit_info', re: /\b(?:do\s+i\s+need\s+(?:a\s+)?wetsuit|should\s+i\s+bring\s+(?:a\s+)?wetsuit|need\s+(?:a\s+)?wetsuit|wetsuit\s+thickness|serve\s+(?:la\s+)?muta|necesito\s+(?:una\s+)?(?:wetsuit|neopren)|brauche\s+ich\s+(?:einen\s+)?(?:neopren|wetsuit))\b/i },
  { id: 'lesson_times', re: /\b(?:what\s+time\s+(?:are|is)\s+(?:the\s+)?surf\s+lessons?|when\s+are\s+(?:the\s+)?(?:surf\s+)?lessons?|lesson\s+times?|a\s+che\s+ora\s+(?:sono\s+)?(?:le\s+)?(?:lezioni|lezioni\s+di\s+surf)|horario\s+(?:de\s+)?(?:clases|surf)|wann\s+sind\s+(?:die\s+)?surfkurse)\b/i },
  { id: 'transfer_how', re: /\b(?:how\s+(?:does|do)\s+(?:the\s+)?(?:airport\s+)?transfer(?:s)?\s+work|how\s+(?:does|do)\s+transfers?\s+work|come\s+funziona\s+(?:il\s+)?transfer|c[oó]mo\s+funciona\s+(?:el\s+)?transfer|wie\s+funktioniert\s+(?:der\s+)?transfer)\b/i },
  { id: 'payments_info', re: /\b(?:how\s+(?:can|do)\s+i\s+pay|how\s+do\s+payments?\s+work|payment\s+methods?|pay\s+on\s+arrival|posso\s+pagare\s+(?:in\s+)?contanti|puedo\s+pagar\s+en\s+efectivo|kann\s+ich\s+bar\s+(?:bezahlen|zahlen)|(?:pay|pagar|pagare|bezahlen)\s+(?:by\s+)?(?:cash|bank|transfer|efectivo|contanti|bar))\b/i },
  { id: 'yoga_info', re: /\b(?:how\s+(?:does|do)\s+yoga\s+work|can\s+i\s+(?:add|do|have)\s+yoga|posso\s+(?:aggiungere|fare)\s+yoga|puedo\s+(?:a[nñ]adir|hacer)\s+yoga|yoga\s+(?:machen|hinzuf[uü]gen))\b/i },
  { id: 'meals_dinner', re: /\b(?:how\s+(?:does|do)\s+(?:dinners?|meals?)\s+work|can\s+i\s+(?:add|have)\s+dinner|posso\s+cenare|puedo\s+(?:cenar|a[nñ]adir\s+cena)|abendessen\s+(?:dazu|buchen))\b/i },
  { id: 'board_care', re: /\b(?:what\s+(?:do|should)\s+i\s+do\s+with\s+(?:the\s+)?board|after\s+surfing|board\s+storage|rinse\s+(?:the\s+)?board|board\s+care|tavola\s+dopo\s+(?:il\s+)?surf|tabla\s+despu[eé]s)\b/i },
  { id: 'house_rules', re: /\b(?:house\s+rules|fridge\s+label|food\s+box|regole\s+(?:della\s+)?casa|normas\s+(?:de\s+la\s+)?casa|hausregeln)\b/i },
  { id: 'checkin_checkout', re: /\b(?:check[- ]?in\s+time|check[- ]?out\s+time|when\s+can\s+i\s+check[- ]?in|ora\s+(?:di\s+)?check|hora\s+(?:de\s+)?entrada)\b/i },
  { id: 'rentals_info', re: /\b(?:rent\s+(?:a\s+)?(?:board|wetsuit|surfboard)|hire\s+(?:a\s+)?board|can\s+i\s+rent|noleggiare\s+(?:una\s+)?tavola|alquilar\s+(?:una\s+)?tabla|(?:board|surfbrett)\s+mieten)\b/i },
  { id: 'rooms_beds', re: /\b(?:which\s+room|room\s+assignment|private\s+room|shared\s+room|quale\s+camera|habitaci[oó]n\s+privada|privatzimmer)\b/i },
  { id: 'local_area', re: /\b(?:restaurants?\s+(?:in\s+)?somo|bars?\s+(?:in\s+)?somo|what\s+to\s+do\s+(?:in\s+)?somo|local\s+tips|cosa\s+fare\s+a\s+somo|qu[eé]\s+hacer\s+en\s+somo)\b/i },
];

const MIDFLOW_TAILS = {
  en: {
    addons: 'Are you going to need a wetsuit, surfboard, and/or lessons, or just the stay?',
    payment: 'Want to pay the deposit or the full amount to hold the spot?',
    continue: 'Want me to keep going with your booking?',
    guests: 'How many guests is it for?',
  },
  it: {
    addons: 'Ti servono muta, tavola e/o lezioni, o solo il soggiorno?',
    payment: 'Preferisci pagare il deposito o l\'importo completo per bloccare?',
    continue: 'Vuoi che continui con la prenotazione?',
    guests: 'Quanti siete?',
  },
  es: {
    addons: '¿Necesitas wetsuit, tabla y/o clases, o solo el alojamiento?',
    payment: '¿Prefieres pagar el depósito o el importe completo para reservar?',
    continue: '¿Seguimos con tu reserva?',
    guests: '¿Cuántos sois?',
  },
  de: {
    addons: 'Brauchst du Neopren, Board und/oder Kurse, oder nur die Unterkunft?',
    payment: 'Lieber Anzahlung oder Vollbetrag, um zu reservieren?',
    continue: 'Soll ich mit deiner Buchung weitermachen?',
    guests: 'Für wie viele Gäste?',
  },
};

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeCategoryId(categoryId) {
  const id = trimStr(categoryId);
  return CATEGORY_ALIASES[id] || id;
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
  const id = normalizeCategoryId(categoryId);
  return config.categories.find((c) => c && c.id === id) || null;
}

function hasActiveQuoteContext(guestContext) {
  const ctx = guestContext || {};
  const quote = ctx.quote && typeof ctx.quote === 'object' ? ctx.quote : {};
  if (quote.quote_status === 'ready') return true;
  const fields = ctx.extracted_fields || (ctx.result && ctx.result.extracted_fields) || {};
  return !!(fields.check_in && fields.check_out);
}

function hasActivePaymentWire(guestContext) {
  try {
    const { shouldAttemptGuestPaymentChoiceWire } = require('./luna-guest-payment-choice-dry-run');
    return shouldAttemptGuestPaymentChoiceWire(guestContext);
  } catch (_) {
    return false;
  }
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

function detectLangFromMessage(text) {
  const t = String(text || '');
  if (/\b(?:Qual[eè]\s+il|codice\s+del\s+cancello|asciugamani|lenzuola|muta|contanti|bonifico|prenotazione|soggiorno|confermata|grazie)\b/i.test(t)) return 'it';
  if (/\b(?:Cu[aá]l\s+es|c[oó]digo\s+del\s+port[oó]n|toallas|s[aá]banas|efectivo|transferencia|confirmada|reserva|gracias)\b/i.test(t)) return 'es';
  if (/\b(?:Wie\s+ist|Torcode|Handtuch|Bettw[aä]sche|Neopren|bezahlen|Anzahlung|best[aä]tigt|Buchung)\b/i.test(t)) return 'de';
  return null;
}

function resolveKnowledgeLanguage(messageText, explicitLang) {
  const fromMsg = detectLangFromMessage(messageText);
  if (fromMsg) return fromMsg;
  const lang = trimStr(explicitLang).slice(0, 2);
  if (lang && lang !== 'en') return lang;
  const t = String(messageText || '');
  if (/\b(?:devo|portare|lenzuola|muta|lezioni|soggiorno)\b/i.test(t)) return 'it';
  if (/\b(?:necesito|llevar|julio|dep[oó]sito|estancia)\b/i.test(t)) return 'es';
  if (/\b(?:brauche|mitbringen|Surfkurse|Ankunft)\b/i.test(t)) return 'de';
  return lang || 'en';
}

function shouldPrioritizeKnowledgeOverService(text, intent, guestContext) {
  const t = String(text || '');
  const ctx = guestContext || {};
  const quoteActive = hasActiveQuoteContext(ctx);
  const paymentWire = hasActivePaymentWire(ctx);

  const informational = [
    'location', 'towels_sheets', 'packing', 'lesson_times', 'board_care',
    'gate_code', 'house_rules', 'checkin_checkout', 'transfer_how',
    'payments_info', 'yoga_info', 'meals_dinner', 'rooms_beds', 'local_area',
    'rentals_info',
  ];

  if (informational.includes(intent)) {
    if (intent === 'payments_info') {
      try {
        const { detectPaymentChoiceFromMessage } = require('./luna-guest-payment-choice-dry-run');
        if (detectPaymentChoiceFromMessage(t) && (quoteActive || paymentWire)) return false;
      } catch (_) { /* noop */ }
      return true;
    }
    if (intent === 'transfer_how') {
      try {
        const { isPaymentMethodTransferQuestion } = require('./luna-guest-service-transfer-explainer');
        if (typeof isPaymentMethodTransferQuestion === 'function' && isPaymentMethodTransferQuestion(t)) {
          return false;
        }
      } catch (_) { /* noop */ }
      if (!/\b(?:how|come|como|c[oó]mo|wie|funziona|funciona|funktioniert)\b/i.test(t)) return false;
    }
    if ((intent === 'yoga_info' || intent === 'meals_dinner') && quoteActive
      && /\b(?:add|book|request|añadir|aggiung|anadir)\b/i.test(t)) {
      return false;
    }
    return true;
  }
  if (intent === 'wetsuit_info') {
    return /\b(?:do\s+i\s+need|should\s+i\s+bring|need|serve|brauche|necesito|ho\s+bisogno)\b/i.test(t)
      || /\b(?:wetsuit|muta|neopren)\b/i.test(t);
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

function resolveEscalationDefault(config, lang) {
  const L = trimStr(lang).slice(0, 2) || 'en';
  const esc = config && config.escalation_default;
  if (esc && typeof esc === 'object') return esc[L] || esc.en || '';
  return trimStr(esc);
}

function buildMidFlowKnowledgeReturnTail(fields, quote, pc, lang, messageText) {
  const { quoteAwaitingAddonsDecision } = require('./luna-booking-addons-policy');
  const L = resolveKnowledgeLanguage(messageText, lang);
  const tails = MIDFLOW_TAILS[L] || MIDFLOW_TAILS.en;
  const checkIn = trimStr(fields && fields.check_in);
  const checkOut = trimStr(fields && fields.check_out);
  const guests = fields && fields.guest_count != null ? Number(fields.guest_count) : null;

  if (quote && quote.quote_status === 'ready') {
    if (quoteAwaitingAddonsDecision(quote)) return tails.addons;
    if (pc && pc.payment_choice_needed === true) return tails.payment;
    return tails.continue;
  }

  if (checkIn && checkOut && guests != null) return tails.continue;
  if (checkIn && checkOut) return tails.guests;
  return null;
}

function buildGuestKnowledgeReply(input) {
  const inp = input || {};
  const clientSlug = trimStr(inp.client_slug) || DEFAULT_CLIENT;
  const messageText = trimStr(inp.message_text);
  const lang = resolveKnowledgeLanguage(messageText, trimStr(inp.lang).slice(0, 2) || 'en');
  const categoryId = normalizeCategoryId(trimStr(inp.category_id) || detectGuestKnowledgeIntent(messageText));
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
      language: lang,
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
      language: lang,
    };
  }

  if (isPrivateCategory(category) && !canRevealPrivateBookingDetails(guestContext)) {
    const tpl = (category.templates && (category.templates[lang] || category.templates.en)) || null;
    let reply = tpl || 'That detail is shared once your booking is confirmed 🔒';
    if (GATE_CODE_RE.test(reply)) {
      reply = (category.templates && category.templates.en) || reply;
    }
    const tail = preserveContext ? buildMidFlowKnowledgeReturnTail(fields, quote, pc, lang, messageText) : null;
    if (tail) reply = `${reply} ${tail}`;
    return {
      reply,
      category: categoryId,
      visibility: 'private',
      allowed_guest_answer: false,
      requires_staff_confirmation: true,
      language: lang,
    };
  }

  const mapsLink = (config && config.maps_link) || '';
  const templateKey = canRevealPrivateBookingDetails(guestContext) && category.templates && category.templates[`${lang}_confirmed`]
    ? `${lang}_confirmed`
    : lang;
  const template = (category.templates && (category.templates[templateKey] || category.templates.en)) || null;
  let reply = interpolateTemplate(template, { maps_link: mapsLink });
  if (!reply) {
    reply = resolveEscalationDefault(config, lang) || 'The team will confirm the exact details with you.';
  }

  if (GATE_CODE_RE.test(reply) && !canRevealPrivateBookingDetails(guestContext)) {
    reply = (category.templates && (category.templates[lang] || category.templates.en))
      || 'The gate code comes with your confirmed booking/check-in info once the stay is locked in 🔒';
  }

  const tail = preserveContext ? buildMidFlowKnowledgeReturnTail(fields, quote, pc, lang, messageText) : null;
  if (tail) reply = `${reply} ${tail}`;

  return {
    reply,
    category: categoryId,
    visibility: category.visibility || 'public',
    allowed_guest_answer: category.allowed_guest_answer !== false,
    requires_staff_confirmation: category.requires_staff_confirmation === true,
    language: lang,
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

function categoryHasMultilingualTemplates(categoryId, langs) {
  const cat = findCategory(loadKnowledgeConfig(DEFAULT_CLIENT), categoryId);
  if (!cat || !cat.templates) return false;
  return langs.every((l) => trimStr(cat.templates[l]).length > 0);
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
  categoryHasMultilingualTemplates,
  resolveKnowledgeLanguage,
  detectLangFromMessage,
  isPrivateCategory,
  DEFAULT_CLIENT,
};
