'use strict';

/**
 * Stage 38a — Add-on service confirmation + optional pay-now UX policy.
 *
 * Copy + recording contract only. Payment truth remains Stripe/webhook-owned.
 * Services may be held/booked unpaid; guest can settle at checkout.
 */

const {
  classifyServiceInterestPricing,
  normalizeServiceInterestCodes,
  normalizeAddOnsForQuote,
} = require('./luna-booking-addons-policy');

const ADDON_ATTACH_ORIGIN = 'luna_guest_addon_38a';

const SERVICE_RULES = Object.freeze({
  wetsuit: {
    service_type: 'wetsuit',
    confirmation_mode: 'held',
    needs_scheduling: false,
    pay_now_optional: true,
    settle_at_checkout: true,
    record_status: 'confirmed',
  },
  surfboard: {
    service_type: 'surfboard',
    confirmation_mode: 'held',
    needs_scheduling: false,
    pay_now_optional: true,
    settle_at_checkout: true,
    record_status: 'confirmed',
  },
  surf_lesson: {
    service_type: 'surf_lesson',
    confirmation_mode: 'booked',
    needs_scheduling: true,
    pay_now_optional: true,
    settle_at_checkout: true,
    record_status: 'confirmed',
  },
  yoga: {
    service_type: 'yoga',
    confirmation_mode: 'booked',
    needs_scheduling: true,
    pay_now_optional: true,
    settle_at_checkout: true,
    record_status: 'requested',
  },
  meal: {
    service_type: 'meal',
    confirmation_mode: 'booked',
    needs_scheduling: true,
    pay_now_optional: true,
    settle_at_checkout: true,
    record_status: 'requested',
  },
  meals: {
    service_type: 'meal',
    confirmation_mode: 'booked',
    needs_scheduling: true,
    pay_now_optional: true,
    settle_at_checkout: true,
    record_status: 'requested',
  },
});

const PAYMENT_TAIL_EN = 'Feel free to pay whenever you\'re ready, or you can settle it at checkout.';
const PAYMENT_TAIL_NO_FORCE_EN = 'No stress on payment now — it can be settled at checkout.';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function langKey(lang) {
  return trimStr(lang).slice(0, 2).toLowerCase() || 'en';
}

function ruleForCode(code) {
  const c = trimStr(code).toLowerCase();
  return SERVICE_RULES[c] || null;
}

function uniqueServiceCodes(codes) {
  const out = [];
  const seen = new Set();
  for (const raw of codes || []) {
    const c = trimStr(raw).toLowerCase();
    if (!c || seen.has(c)) continue;
    if (c === 'meals') {
      if (!seen.has('meal')) {
        seen.add('meal');
        out.push('meal');
      }
      continue;
    }
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Collect in-scope services from fields + reactive requests.
 */
function collectAddonServicesFromContext(fields, quote, clientSlug) {
  const f = fields || {};
  const priced = classifyServiceInterestPricing(f.service_interest, clientSlug);
  const codes = uniqueServiceCodes([
    ...priced.priced,
    ...priced.pending_manual,
    ...(normalizeServiceInterestCodes(f.service_interest)),
  ]);

  if (f.yoga_request && typeof f.yoga_request === 'object' && !codes.includes('yoga')) {
    codes.push('yoga');
  }
  if (f.meals_request && typeof f.meals_request === 'object' && !codes.includes('meal')) {
    codes.push('meal');
  }

  const pendingManual = normalizeServiceInterestCodes(f.services_pending_manual);
  for (const c of pendingManual) {
    if (c === 'yoga' && !codes.includes('yoga')) codes.push('yoga');
    if ((c === 'meal' || c === 'meals') && !codes.includes('meal')) codes.push('meal');
  }

  const services = [];
  for (const code of codes) {
    const rule = ruleForCode(code);
    if (!rule) continue;
    services.push({
      code: code === 'meals' ? 'meal' : code,
      ...rule,
      priced: priced.priced.includes(code) || priced.priced.includes(code === 'meal' ? 'meals' : code),
    });
  }

  return {
    services,
    priced_codes: priced.priced,
    pending_manual_codes: priced.pending_manual,
    quote_total_cents: quote && quote.quote_total_cents,
  };
}

function buildHeldGearCopy(lang, hasWetsuit, hasBoard) {
  const L = langKey(lang);
  if (L === 'de') {
    if (hasWetsuit && hasBoard) {
      return 'Perfekt — Muta und Board sind für dich reserviert 🌊';
    }
    if (hasWetsuit) return 'Perfekt — die Muta ist für dich reserviert 🌊';
    if (hasBoard) return 'Perfekt — das Board ist für dich reserviert 🌊';
    return null;
  }
  if (hasWetsuit && hasBoard) {
    return 'Perfect — we have the wetsuit and board on hold for you 🌊';
  }
  if (hasWetsuit) return 'Perfect — we have the wetsuit on hold for you 🌊';
  if (hasBoard) return 'Perfect — we have the board on hold for you 🌊';
  return null;
}

function buildServiceConfirmationLine(service, lang, fields) {
  const L = langKey(lang);
  const code = service.code;

  if (code === 'wetsuit' || code === 'surfboard') {
    return null;
  }

  if (code === 'surf_lesson') {
    if (L === 'de') {
      return 'Yesss — die Surf-Stunde ist für dich notiert 🙌 Wir bestätigen die genaue Gruppe näher am Tag.';
    }
    return 'Yesss — I\'ve added the surf lesson for you 🙌 We\'ll confirm the exact lesson group closer to the day.';
  }

  if (code === 'yoga') {
    if (L === 'de') {
      return 'Super — Yoga ist für dich notiert 🧘‍♀️ Das Team plant den Termin und du kannst später zahlen.';
    }
    return 'Lovely — I\'ve added yoga for you 🧘‍♀️ We\'ll keep it pending for the team to schedule, and you can settle it later.';
  }

  if (code === 'meal') {
    const mealType = (fields && fields.meals_request && fields.meals_request.meal_type) || 'dinner';
    if (L === 'de') {
      return mealType === 'dinner'
        ? 'Perfekt — Abendessen ist für dich notiert 🍽️'
        : 'Perfekt — Mahlzeiten sind für dich notiert 🍽️';
    }
    if (mealType === 'dinner' || mealType === 'unspecified') {
      return 'Perfect — I have you down for dinner 🍽️';
    }
    return 'Perfect — I\'ve added meals to your booking 🍽️';
  }

  if (L === 'de') {
    return 'Alles klar — das Extra ist zu deiner Buchung hinzugefügt.';
  }
  return 'Got it — that\'s added to your booking.';
}

function buildServiceConfirmationSection(fields, quote, lang, clientSlug) {
  const ctx = collectAddonServicesFromContext(fields, quote, clientSlug);
  const services = ctx.services;
  if (!services.length) return null;

  const codes = services.map((s) => s.code);
  const hasWetsuit = codes.includes('wetsuit');
  const hasBoard = codes.includes('surfboard');
  const parts = [];

  const gearLine = buildHeldGearCopy(lang, hasWetsuit, hasBoard);
  if (gearLine) {
    parts.push(`${gearLine} ${PAYMENT_TAIL_EN}`);
  }

  for (const svc of services) {
    if (svc.code === 'wetsuit' || svc.code === 'surfboard') continue;
    const line = buildServiceConfirmationLine(svc, lang, fields);
    if (!line) continue;
    if (svc.code === 'meal') {
      parts.push(`${line} ${PAYMENT_TAIL_NO_FORCE_EN}`);
    } else if (svc.code === 'surf_lesson') {
      parts.push(`${line} You can pay now if you like, or settle it at checkout.`);
    } else {
      parts.push(line);
    }
  }

  return parts.length ? parts.join('\n\n') : null;
}

function buildAddonPaymentChoiceReply(input) {
  const src = input || {};
  const deposit = trimStr(src.deposit);
  const total = trimStr(src.total);
  if (!deposit || !total) return null;

  const section = buildServiceConfirmationSection(
    src.fields,
    src.quote,
    src.lang,
    src.client_slug,
  );

  const L = langKey(src.lang);
  const tail = L === 'de'
    ? `Um den Platz zu halten: lieber ${deposit} Anzahlung oder ${total} komplett?`
    : `To hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;

  if (section) {
    return `${section}\n\n${tail}`;
  }
  return null;
}

function buildReactiveServiceConfirmationCopy(lang, intent, fields) {
  const f = fields || {};
  if (intent === 'yoga') {
    return buildServiceConfirmationLine({ code: 'yoga' }, lang, f)
      || buildServiceConfirmationSection({ ...f, yoga_request: { status: 'requested' } }, null, lang, null);
  }
  if (intent === 'meals') {
    const mealType = (f.meals_request && f.meals_request.meal_type) || detectMealTypeFromFields(f) || 'dinner';
    const withMeals = {
      ...f,
      meals_request: { ...(f.meals_request || {}), status: 'requested', meal_type: mealType },
    };
    const line = buildServiceConfirmationLine({ code: 'meal' }, lang, withMeals);
    if (line) return `${line} ${PAYMENT_TAIL_NO_FORCE_EN}`;
  }
  return null;
}

function detectMealTypeFromFields(fields) {
  const req = fields && fields.meals_request;
  if (req && req.meal_type) return req.meal_type;
  return null;
}

function buildAddonServiceObservability(fields, quote, clientSlug) {
  const ctx = collectAddonServicesFromContext(fields, quote, clientSlug);
  const unpaid = ctx.services.filter((s) => s.settle_at_checkout && s.pay_now_optional);
  return {
    addon_services_confirmed: ctx.services.length > 0,
    addon_service_codes: ctx.services.map((s) => s.code),
    addon_services_needs_scheduling: ctx.services.filter((s) => s.needs_scheduling).map((s) => s.code),
    addon_services_held: ctx.services.filter((s) => s.confirmation_mode === 'held').map((s) => s.code),
    addon_services_payment_optional: unpaid.length > 0,
    addon_services_settle_at_checkout: ctx.services.some((s) => s.settle_at_checkout),
    addon_service_attach_origin: ADDON_ATTACH_ORIGIN,
  };
}

function paymentLedgerGapSummary() {
  return {
    service_rows_supported: true,
    service_amount_due_on_record: true,
    service_payment_status_pending_supported: true,
    booking_payment_ledger_per_service_row: false,
    gap: 'Unpaid add-on amounts live on booking_service_records.amount_due_cents / payment_status; no separate payments row per add-on yet (Stage 38b hardening).',
    staff_visibility: 'Services tab + booking detail service records query',
  };
}

function policySummary() {
  return {
    in_scope: ['wetsuit', 'surfboard', 'surf_lesson', 'yoga', 'meal'],
    payment_behavior: {
      paid_now_optional: true,
      settle_at_checkout_allowed: true,
      service_recorded_when_unpaid: true,
      never_claim_paid_without_truth: true,
    },
    ledger: paymentLedgerGapSummary(),
  };
}

module.exports = {
  ADDON_ATTACH_ORIGIN,
  SERVICE_RULES,
  collectAddonServicesFromContext,
  buildServiceConfirmationSection,
  buildServiceConfirmationLine,
  buildAddonPaymentChoiceReply,
  buildReactiveServiceConfirmationCopy,
  buildAddonServiceObservability,
  paymentLedgerGapSummary,
  policySummary,
  ruleForCode,
};
