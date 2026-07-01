'use strict';

/**
 * Stage 32 — add-ons / services policy during active booking flows.
 *
 * Centralizes add-on selection parsing, quote add-on mapping, pricing classification,
 * transfer observability, and mid-flow service return copy.
 */

const fs = require('fs');
const path = require('path');

const { detectPaymentChoiceFromMessage } = require('./luna-guest-payment-choice-dry-run');
const { detectLessonQualifier } = require('./luna-guest-service-transfer-explainer');

const { computeStayNights, formatStayRange, formatGuestPhrase } = require('./wolfhouse-package-night-rules');

const DEFAULT_CLIENT = 'wolfhouse-somo';
const PRICING_PATH = path.join(__dirname, '..', '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

function extractAddOnsFromText(text) {
  const t = String(text || '').toLowerCase();
  const found = new Set();
  if (/\b(?:meal|meals|dinner|food|cena|comida|repas|abendessen)\b/.test(t)) found.add('meal');
  if (/\b(?:yoga)\b/.test(t)) found.add('yoga');
  if (/\b(?:surf\s+lessons?|surfstunde|surfunterricht|surfkurs(?:e|en)?|lessons?|lezione|lezioni|clase(?:s)?\s+de\s+surf|clases?\s+de\s+surf|cours\s+de\s+surf)\b/.test(t)) found.add('surf_lesson');
  if (/\b(?:wetsuit|wesuit|muta|neopren)\b/.test(t)) found.add('wetsuit');
  if (/\b(?:surfboard|soft\s+board|hard\s+board|board|tabla|tavola|planche)\b/.test(t)) found.add('surfboard');
  return [...found];
}

const NO_ADDONS_RE = /\b(?:no\s+thanks?|just\s+the\s+stay|accommodation\s+only|i\s+have\s+my\s+own(?:\s+stuff)?|no\s+add(?:\s+|-)?nothing|nothing\s+else|nothing\s+extra|no\s+extras?|no\s+wetsuit|no\s+board|no\s+lesson)\b/i;

const INTAKE_TO_QUOTE = Object.freeze({
  wetsuit: { code: 'wetsuit_rental', unit: 'per_day' },
  surfboard: { code: 'soft_top_rental', unit: 'per_day' },
  surf_lesson: { code: 'surf_lesson_single', unit: 'per_lesson' },
  yoga: { code: 'yoga_class', unit: 'per_class' },
  meal: { code: 'meals', unit: 'per_meal' },
});

const IN_SCOPE_ADDONS = new Set(['wetsuit', 'surfboard', 'surf_lesson']);

/** Gear/lessons already bundled in weekly packages — do not bill as separate services. */
const PACKAGE_INCLUDED_SERVICE_CODES = Object.freeze({
  uluwatu: new Set(['wetsuit', 'surfboard']),
  waimea: new Set(['wetsuit', 'surfboard', 'surf_lesson']),
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function guestDeclinedAddons(text) {
  const t = String(text || '');
  const surfAddons = extractAddOnsFromText(t).filter((code) => IN_SCOPE_ADDONS.has(code));
  if (surfAddons.length > 0) return false;
  return NO_ADDONS_RE.test(t);
}

function extractAddOnSelectionsRaw(messageText) {
  const text = trimStr(messageText);
  if (!text || guestDeclinedAddons(text)) return [];

  const found = new Set(extractAddOnsFromText(text));
  if (/\b(?:all\s+three|wetsuit.*(?:board|surfboard).*(?:lesson|lessons)|(?:board|surfboard).*wetsuit.*(?:lesson|lessons))\b/i.test(text)) {
    found.add('wetsuit');
    found.add('surfboard');
    found.add('surf_lesson');
  }
  if (/\b(?:gear\s+and\s+lessons?|lessons?\s+and\s+gear)\b/i.test(text)) {
    found.add('wetsuit');
    found.add('surfboard');
    found.add('surf_lesson');
  }
  if (/\b(?:wetsuit\s+and\s+lesson|wetsuit\s+and\s+lessons?|board\s+and\s+wetsuit|wetsuit\s+and\s+board)\b/i.test(text)) {
    if (/\b(?:wetsuit|wesuit)\b/i.test(text)) found.add('wetsuit');
    if (/\b(?:board|surfboard)\b/i.test(text)) found.add('surfboard');
    if (/\blessons?\b/i.test(text)) found.add('surf_lesson');
  }
  if (/\b(?:board\s+rental|rent(?:al)?\s+board)\b/i.test(text)) {
    found.add('surfboard');
  }

  // Private/group lesson split: only a GROUP-qualified lesson is the €35 System A add-on.
  // Private → catalog "Private Lesson" card; bare "lesson" → Luna asks private-or-group.
  // Either way it's not an auto-selected surf_lesson here (see explain_service_addon path).
  if (found.has('surf_lesson') && detectLessonQualifier(text) !== 'group') {
    found.delete('surf_lesson');
  }

  return [...found].filter((code) => IN_SCOPE_ADDONS.has(code));
}

function isExplicitAddonSelectionMessage(text) {
  const t = trimStr(text);
  if (!t) return false;
  if (guestDeclinedAddons(t)) return true;
  return extractAddOnSelectionsRaw(t).length > 0;
}

function isAddonSideQuestion(text) {
  const t = trimStr(text);
  if (!t) return false;
  if (isExplicitAddonSelectionMessage(t)) return false;
  const isQuestion = /\?\s*$/.test(t)
    || /\b(?:do you|can i|can we|can you|do we|is there|are there|how much|what(?:'s| is| are)|do i need)\b/i.test(t);
  if (!isQuestion) return false;
  return /\b(?:rent|hire|offer|lessons?|wetsuit|surfboard|board|transfer|gear|included|include)\b/i.test(t);
}

function shouldTreatAsServiceSideQuestion(text, quote) {
  if (!text || isExplicitAddonSelectionMessage(text)) return false;
  if (quote && quoteAwaitingAddonsDecision(quote) && extractAddOnSelectionsRaw(text).length > 0) {
    return false;
  }
  return true;
}

function extractAddOnSelections(messageText) {
  const text = trimStr(messageText);
  if (!text || guestDeclinedAddons(text)) return [];
  if (isAddonSideQuestion(text)) return [];
  return extractAddOnSelectionsRaw(text);
}

function normalizeServiceInterestItem(item) {
  if (item == null) return null;
  if (typeof item === 'string') return trimStr(item).toLowerCase() || null;
  if (typeof item === 'object' && item.code) return trimStr(item.code).toLowerCase() || null;
  return null;
}

function normalizeServiceInterestCodes(serviceInterest) {
  if (!Array.isArray(serviceInterest)) return [];
  return serviceInterest
    .map(normalizeServiceInterestItem)
    .filter(Boolean)
    .sort();
}

function serviceInterestSignature(serviceInterest, addonsSkipped) {
  if (addonsSkipped === true) return 'declined';
  const codes = normalizeServiceInterestCodes(serviceInterest);
  return codes.length ? codes.join(',') : 'none';
}

function quoteAwaitingAddonsDecision(quote) {
  if (!quote || quote.quote_status !== 'ready') return false;
  return quote.addons_pending_after_quote === true || quote.short_stay_addons_pending === true;
}

function addonsResolvedFromFields(fields) {
  const f = fields || {};
  if (f.addons_skipped === true) return true;
  const codes = normalizeServiceInterestCodes(f.service_interest);
  return codes.length > 0;
}

/**
 * Stage 45i — clear deposit/full payment choice while add-ons are pending implies
 * "just the stay" (no surf gear/lessons add-ons). Vague or add-on side questions do not count.
 */
function paymentChoiceDeclinesPendingAddons(messageText) {
  const t = trimStr(messageText);
  if (!t || isAddonSideQuestion(t)) return false;
  if (extractAddOnSelectionsRaw(t).length > 0) return false;
  const detected = detectPaymentChoiceFromMessage(t);
  return detected === 'deposit' || detected === 'full_payment';
}

function addonsAnsweredThisTurn(messageText, brainDecision, fields) {
  if (brainDecision && brainDecision.intent === 'accommodation_only_choice') return true;
  if (guestDeclinedAddons(messageText)) return true;
  if (paymentChoiceDeclinesPendingAddons(messageText)) return true;
  if (extractAddOnSelections(messageText).length > 0) return true;
  if (addonsResolvedFromFields(fields)) return true;
  return false;
}

function readPricingConfig(clientSlug) {
  const slug = trimStr(clientSlug) || DEFAULT_CLIENT;
  if (slug !== DEFAULT_CLIENT) return null;
  try {
    return JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function classifyIntakeAddonPricing(intakeCode, config) {
  const map = INTAKE_TO_QUOTE[intakeCode];
  if (!map) {
    return { intake_code: intakeCode, priced: false, pending_manual: true, quote_code: null };
  }
  const cfg = config && config.add_ons && config.add_ons[map.code];
  if (!cfg || cfg.pricing_status !== 'confirmed' || cfg.price_cents == null) {
    return {
      intake_code: intakeCode,
      priced: false,
      pending_manual: true,
      quote_code: map.code,
    };
  }
  return {
    intake_code: intakeCode,
    priced: true,
    pending_manual: false,
    quote_code: map.code,
    unit: map.unit,
    price_cents: cfg.price_cents,
  };
}

function classifyServiceInterestPricing(serviceInterest, clientSlug) {
  const config = readPricingConfig(clientSlug);
  const codes = normalizeServiceInterestCodes(serviceInterest);
  const priced = [];
  const pendingManual = [];
  for (const code of codes) {
    const intakeCode = INTAKE_TO_QUOTE[code] ? code : null;
    if (!intakeCode) {
      pendingManual.push(code);
      continue;
    }
    const cls = classifyIntakeAddonPricing(intakeCode, config);
    if (cls.priced) priced.push(cls.intake_code);
    else pendingManual.push(cls.intake_code);
  }
  return { priced, pending_manual: pendingManual, config_loaded: !!config };
}

function mapServiceInterestToQuoteAddOns(serviceInterest, nights, guestCount = 1) {
  const stayDays = Math.max(1, Number(nights) || 1);
  const peopleDefault = Math.max(1, Number(guestCount) || 1);
  const codes = normalizeServiceInterestCodes(serviceInterest);
  const out = [];
  let lessonQty = 0;

  for (const intakeCode of codes) {
    const map = INTAKE_TO_QUOTE[intakeCode];
    if (!map) continue;
    if (map.unit === 'per_day') {
      out.push({ code: map.code, days: stayDays, quantity: peopleDefault });
    } else if (map.unit === 'per_lesson') {
      lessonQty += 1;
    } else if (map.unit === 'per_class' || map.unit === 'per_meal') {
      out.push({ code: map.code, quantity: 1 });
    }
  }

  if (lessonQty > 0) {
    out.push({ code: 'surf_lesson_single', quantity: lessonQty });
  }

  return out;
}

function normalizeAddOnsForQuote(serviceInterest, nights, guestCount = 1) {
  if (!Array.isArray(serviceInterest) || !serviceInterest.length) return [];
  const objectItems = serviceInterest.filter((item) => item && typeof item === 'object' && item.code);
  if (objectItems.length) {
    return objectItems.map((item) => ({
      code: String(item.code).trim(),
      days: item.days != null ? Number(item.days) : undefined,
      quantity: item.quantity != null ? Number(item.quantity) : undefined,
    }));
  }
  return mapServiceInterestToQuoteAddOns(serviceInterest, nights, guestCount);
}

/** "We'll take a board" for N guests → N boards unless guest names a smaller count. */
function inferGroupGearPeopleCount(messageText, guestCount, explicitCount) {
  if (explicitCount != null && Number(explicitCount) > 0) {
    return Math.min(Math.max(1, Number(guestCount) || 1), Math.max(1, Number(explicitCount)));
  }
  const t = String(messageText || '');
  const gc = Math.max(1, Number(guestCount) || 1);
  const explicitPeople = t.match(/\b(?:for\s+)?(\d+)\s+(?:people|persons?|guests?|of\s+us|ppl)\b/i);
  if (explicitPeople) {
    return Math.min(gc, Math.max(1, parseInt(explicitPeople[1], 10) || 1));
  }
  const onlySome = t.match(/\b(?:just|only)\s+(?:me|one|1)\b/i);
  if (onlySome) return 1;
  if (/\b(?:we(?:'ll|\s+will)?\s+(?:take|want|need|get)|we\s+want|for\s+all\s+of\s+us|everyone)\b/i.test(t)) {
    return gc;
  }
  return gc;
}

function detectPricedAddonQuoteChange(priorFields, currentFields, clientSlug) {
  const prior = priorFields || {};
  const current = currentFields || {};
  const priorSig = serviceInterestSignature(prior.service_interest, prior.addons_skipped);
  const currentSig = serviceInterestSignature(current.service_interest, current.addons_skipped);
  if (priorSig === currentSig) return null;

  // Guest declining optional surf add-ons completes the add-ons step — not quote invalidation.
  if (current.addons_skipped === true && prior.addons_skipped !== true) {
    const priorPricedEarly = [...classifyServiceInterestPricing(prior.service_interest, clientSlug).priced].sort().join(',');
    const currentPricedEarly = [...classifyServiceInterestPricing(current.service_interest, clientSlug).priced].sort().join(',');
    if (priorPricedEarly === currentPricedEarly) return null;
  }

  const priorCls = classifyServiceInterestPricing(prior.service_interest, clientSlug);
  const currentCls = classifyServiceInterestPricing(current.service_interest, clientSlug);
  const priorPriced = [...priorCls.priced].sort().join(',');
  const currentPriced = [...currentCls.priced].sort().join(',');

  if (priorPriced !== currentPriced) {
    return {
      reason: 'addons_changed',
      stale_quote_reason: 'addons_changed',
      corrected_fields: ['service_interest'],
      add_on_quote_stale_reason: 'priced_addons_changed',
    };
  }

  if (priorSig !== currentSig) {
    return {
      reason: 'addons_selection_changed',
      stale_quote_reason: 'addons_selection_changed',
      corrected_fields: ['service_interest'],
      add_on_quote_stale_reason: priorPriced !== currentPriced ? 'priced_addons_changed' : 'manual_addons_changed',
    };
  }
  return null;
}

function resolveAddOnsStatus(fields, quote) {
  const f = fields || {};
  const q = quote || {};
  if (q.quote_status !== 'ready') return 'not_asked';
  if (f.addons_skipped === true) return 'declined';
  const codes = normalizeServiceInterestCodes(f.service_interest);
  if (codes.length) return 'collected';
  if (quoteAwaitingAddonsDecision(q)) return 'pending';
  return 'collected';
}

function stripPackageIncludedGearFromServiceInterest(fields) {
  const f = fields || {};
  const pkg = trimStr(f.package_interest).toLowerCase();
  const included = PACKAGE_INCLUDED_SERVICE_CODES[pkg];
  if (!included) return f;
  const list = Array.isArray(f.service_interest) ? f.service_interest : [];
  if (!list.length) return f;
  const filtered = list.filter((item) => {
    const code = typeof item === 'string'
      ? trimStr(item).toLowerCase()
      : (item && item.code ? trimStr(item.code).toLowerCase() : '');
    return code && !included.has(code);
  });
  if (filtered.length === list.length) return f;
  return { ...f, service_interest: filtered };
}

function extractTransferObservability(fields) {
  const f = fields || {};
  const transfer = f.transfer_info || f.transfer_interest || null;
  if (!transfer || typeof transfer !== 'object') {
    return {
      transfer_info_status: 'not_applicable',
      transfer_airport: null,
      transfer_arrival_time: null,
      transfer_departure_time: null,
      transfer_flight_number: null,
    };
  }
  const airport = transfer.airport_code || null;
  const arrival = transfer.arrival_time || null;
  const departure = transfer.departure_time || null;
  const flight = transfer.flight_number || null;
  let status = 'partial';
  if (transfer.deferred === true) status = 'deferred';
  else if (airport && (arrival || flight)) status = 'complete';
  else if (airport || arrival || flight) status = 'partial';
  return {
    transfer_info_status: status,
    transfer_airport: airport,
    transfer_arrival_time: arrival,
    transfer_departure_time: departure,
    transfer_flight_number: flight,
  };
}

function buildManualAddonsNote(lang, pendingManual) {
  const items = (pendingManual || []).map((c) => {
    if (c === 'surf_lesson') return 'lessons';
    if (c === 'surfboard') return 'gear';
    if (c === 'wetsuit') return 'gear';
    return c;
  });
  const unique = [...new Set(items)];
  const label = unique.length ? unique.join('/') : 'extras';
  const L = trimStr(lang).slice(0, 2) || 'en';
  if (L === 'de') {
    return `Kein Problem — ich notiere dein Interesse an ${label}. Das Team bestätigt die Details, aber wir können den Aufenthalt schon reservieren.`;
  }
  return `No problem — I'll note that you're interested in ${label}. The team can confirm the exact details, but we can still hold the stay now.`;
}

function packageIncludesLessons(fields) {
  const pkg = trimStr(fields && (fields.package_interest || fields.package_code || fields.package)).toLowerCase();
  return !!(PACKAGE_INCLUDED_SERVICE_CODES[pkg] && PACKAGE_INCLUDED_SERVICE_CODES[pkg].has('surf_lesson'));
}

function buildMidFlowAddonsReturnTail(fields, lang, quote) {
  const range = formatStayRange(fields.check_in, fields.check_out);
  const guestPhrase = formatGuestPhrase(lang || 'en', fields.guest_count);
  const ctx = range && guestPhrase ? `${range} for ${guestPhrase}` : (range || guestPhrase || '');

  if (quoteAwaitingAddonsDecision(quote)) {
    if (ctx) {
      var offer = packageIncludesLessons(fields) ? 'a board, wetsuit, or just the stay' : 'a board, wetsuit, private lesson, or just the stay';
      return `For your booking, I have ${ctx}. Are you going to need ${offer}?`;
    }
    return packageIncludesLessons(fields)
      ? 'Are you going to need a wetsuit, surfboard, or just the stay?'
      : 'Are you going to need a wetsuit, surfboard, private lesson, or just the stay?';
  }
  return 'Want me to keep going with your booking?';
}

function buildAddonsObservability(state, context, quote, invalidation) {
  const fields = (state && state.extracted_fields) || {};
  const ctx = context || {};
  const q = quote || ctx.quote || {};
  const nights = computeStayNights(fields.check_in, fields.check_out);
  const cls = classifyServiceInterestPricing(fields.service_interest, ctx.client_slug);
  const transfer = extractTransferObservability(fields);
  const status = resolveAddOnsStatus(fields, q);

  return {
    addons_status: status,
    addons_requested: normalizeServiceInterestCodes(fields.service_interest),
    addons_priced: cls.priced,
    addons_pending_manual: cls.pending_manual,
    add_on_quote_stale_reason: (invalidation && invalidation.add_on_quote_stale_reason)
      || (q && q.add_on_quote_stale_reason)
      || null,
    addons_quote_add_ons: normalizeAddOnsForQuote(fields.service_interest, nights),
    ...transfer,
  };
}

module.exports = {
  NO_ADDONS_RE,
  PACKAGE_INCLUDED_SERVICE_CODES,
  guestDeclinedAddons,
  paymentChoiceDeclinesPendingAddons,
  extractAddOnSelections,
  stripPackageIncludedGearFromServiceInterest,
  normalizeServiceInterestCodes,
  serviceInterestSignature,
  quoteAwaitingAddonsDecision,
  packageIncludesLessons,
  addonsResolvedFromFields,
  addonsAnsweredThisTurn,
  classifyServiceInterestPricing,
  mapServiceInterestToQuoteAddOns,
  normalizeAddOnsForQuote,
  inferGroupGearPeopleCount,
  detectPricedAddonQuoteChange,
  resolveAddOnsStatus,
  extractTransferObservability,
  buildManualAddonsNote,
  buildMidFlowAddonsReturnTail,
  buildAddonsObservability,
  isAddonSideQuestion,
  isExplicitAddonSelectionMessage,
  shouldTreatAsServiceSideQuestion,
};
