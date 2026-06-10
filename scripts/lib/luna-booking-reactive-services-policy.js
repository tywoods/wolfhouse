'use strict';

/**
 * Stage 32b — reactive meals/yoga during active booking (not proactive surf add-ons).
 *
 * Meals and yoga are stored as structured pending service requests; they do not
 * block the stay quote/deposit path and are never included in the proactive
 * wetsuit/board/lessons add-on question.
 */

const fs = require('fs');
const path = require('path');

const { formatStayRange, formatGuestPhrase } = require('./wolfhouse-package-night-rules');
const { quoteAwaitingAddonsDecision } = require('./luna-booking-addons-policy');

const DEFAULT_CLIENT = 'wolfhouse-somo';
const PRICING_PATH = path.join(__dirname, '..', '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

const DECIDE_LATER_RE = /\b(?:decide\s+later|i(?:'ll|\s+will)\s+decide|let\s+you\s+know\s+later|not\s+sure\s+yet|maybe\s+later|tell\s+you\s+later|send\s+(?:details|times)\s+later)\b/i;

const MEAL_TYPE_MAP = [
  { re: /\b(?:all\s+meals|full\s+board|breakfast\s+lunch\s+(?:and\s+)?dinner)\b/i, type: 'all' },
  { re: /\b(?:breakfast|frühstück|colazione|petit\s+d[eé]jeuner)\b/i, type: 'breakfast' },
  { re: /\b(?:lunch|mittagessen|pranzo|d[eé]jeuner)\b/i, type: 'lunch' },
  { re: /\b(?:dinner|dinners|abendessen|cena|d[iî]ner|repas)\b/i, type: 'dinner' },
];

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function guestDecidedLater(text) {
  return DECIDE_LATER_RE.test(String(text || ''));
}

function isReactiveServiceMessage(text) {
  return detectReactiveServiceIntent(text) != null;
}

function detectReactiveServiceIntent(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (/\b(?:yoga(?:\s+class(?:es)?)?)\b/i.test(t)
    && /\b(?:add|book|join|take|get|can i|can we|do you|offer|have|yoga)\b/i.test(t)) {
    return 'yoga';
  }
  if (/\b(?:yoga)\b/i.test(t) && /\?\s*$/.test(t.trim())) return 'yoga';
  if (/\b(?:meal|meals|dinner|dinners|breakfast|lunch|food|cena|comida|repas|abendessen)\b/i.test(t)
    && /\b(?:add|book|reserve|get|can i|can we|do you|offer|have|want|need)\b/i.test(t)) {
    return 'meals';
  }
  if (/\b(?:book|reserve)\b.*\b(?:dinner|dinners|meals|breakfast|lunch)\b/i.test(t)) return 'meals';
  if (/\b(?:dinner|dinners|meals)\b/i.test(t) && /\?\s*$/.test(t.trim())) return 'meals';
  return null;
}

function detectMealType(text) {
  const t = String(text || '');
  for (const row of MEAL_TYPE_MAP) {
    if (row.re.test(t)) return row.type;
  }
  if (/\b(?:meal|meals|food)\b/i.test(t)) return 'unspecified';
  return null;
}

function extractRequestedDays(text, checkIn, checkOut) {
  const t = String(text || '').toLowerCase();
  const dates = [];
  const monthRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/gi;
  let m;
  while ((m = monthRe.exec(t)) !== null) {
    const month = m[1].slice(0, 3).toLowerCase();
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const mo = months[month.slice(0, 3)];
    if (!mo) continue;
    const year = checkIn ? checkIn.slice(0, 4) : '2026';
    const d1 = Number(m[2]);
    dates.push(`${year}-${String(mo).padStart(2, '0')}-${String(d1).padStart(2, '0')}`);
    if (m[3]) {
      const d2 = Number(m[3]);
      dates.push(`${year}-${String(mo).padStart(2, '0')}-${String(d2).padStart(2, '0')}`);
    }
  }
  if (/\b(?:all\s+(?:nights|days|stay)|every\s+(?:night|day)|whole\s+stay)\b/i.test(t) && checkIn && checkOut) {
    return { mode: 'all_stay', dates: [] };
  }
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const foundDays = weekdays.filter((d) => new RegExp(`\\b${d}\\b`, 'i').test(t));
  if (foundDays.length) return { mode: 'weekdays', days: foundDays, dates: [] };
  if (dates.length) return { mode: 'dates', dates };
  return null;
}

function extractDietaryNotes(text) {
  const t = String(text || '');
  const m = t.match(/\b(?:vegetarian|vegan|gluten[- ]free|allerg(?:y|ies)|no\s+(?:pork|meat|fish|dairy))\b[^.?!\n]*/i);
  return m ? trimStr(m[0]) : null;
}

function extractYogaSessionHint(text) {
  const t = String(text || '');
  if (/\b(?:morning|am)\b/i.test(t)) return 'morning';
  if (/\b(?:afternoon|pm|evening)\b/i.test(t)) return 'afternoon';
  return null;
}

function mergeMealsRequest(prior, patch) {
  const p = prior && typeof prior === 'object' ? { ...prior } : {};
  const n = patch && typeof patch === 'object' ? patch : {};
  if (n.meal_type) p.meal_type = n.meal_type;
  if (n.requested_dates) p.requested_dates = [...new Set([...(p.requested_dates || []), ...n.requested_dates])];
  if (n.requested_days) p.requested_days = [...new Set([...(p.requested_days || []), ...n.requested_days])];
  if (n.guest_count != null) p.guest_count = n.guest_count;
  if (n.dietary_notes) p.dietary_notes = n.dietary_notes;
  if (n.status) p.status = n.status;
  if (n.deferred === true) p.deferred = true;
  return p;
}

function mergeYogaRequest(prior, patch) {
  const p = prior && typeof prior === 'object' ? { ...prior } : {};
  const n = patch && typeof patch === 'object' ? patch : {};
  if (n.requested_dates) p.requested_dates = [...new Set([...(p.requested_dates || []), ...n.requested_dates])];
  if (n.requested_days) p.requested_days = [...new Set([...(p.requested_days || []), ...n.requested_days])];
  if (n.preferred_time) p.preferred_time = n.preferred_time;
  if (n.guest_count != null) p.guest_count = n.guest_count;
  if (n.status) p.status = n.status;
  if (n.deferred === true) p.deferred = true;
  return p;
}

function mealsNeedsDayDetails(req) {
  const r = req || {};
  if (r.deferred === true || r.status === 'interested') return false;
  const hasDates = Array.isArray(r.requested_dates) && r.requested_dates.length > 0;
  const hasDays = Array.isArray(r.requested_days) && r.requested_days.length > 0;
  return !hasDates && !hasDays && r.status !== 'needs_staff_confirmation';
}

function yogaNeedsSessionDetails(req) {
  const r = req || {};
  if (r.deferred === true || r.status === 'interested') return false;
  const hasDates = Array.isArray(r.requested_dates) && r.requested_dates.length > 0;
  const hasDays = Array.isArray(r.requested_days) && r.requested_days.length > 0;
  const hasTime = !!r.preferred_time;
  return !hasDates && !hasDays && !hasTime && r.status !== 'needs_staff_confirmation';
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

/**
 * Staff-side scheduling exists (booking_service_records) but guest dry-run stores pending only.
 */
function resolveGuestSchedulingCapability() {
  return {
    staff_schedule_module: 'staff-booking-services-schedule',
    guest_attach_available: false,
    attach_after_hold: true,
  };
}

function resolveReactiveServiceStatus(hasDetails, deferred) {
  if (deferred) return 'interested';
  if (hasDetails) return 'needs_staff_confirmation';
  return 'requested';
}

function extractReactiveServicesFromMessage(messageText, priorFields, context) {
  const text = trimStr(messageText);
  const prior = priorFields || {};
  const ctx = context || {};
  const patch = {};

  if (!text) return patch;

  const intent = detectReactiveServiceIntent(text);
  const decideLater = guestDecidedLater(text);

  if (intent === 'yoga' || (/\b(?:yoga)\b/i.test(text) && decideLater && prior.yoga_request)) {
    const dayInfo = extractRequestedDays(text, prior.check_in, prior.check_out);
    const yogaPatch = {
      status: decideLater ? 'interested' : resolveReactiveServiceStatus(
        !!(dayInfo && (dayInfo.dates?.length || dayInfo.days?.length)),
        decideLater,
      ),
      deferred: decideLater || undefined,
    };
    if (dayInfo && dayInfo.dates) yogaPatch.requested_dates = dayInfo.dates;
    if (dayInfo && dayInfo.days) yogaPatch.requested_days = dayInfo.days;
    const session = extractYogaSessionHint(text);
    if (session) yogaPatch.preferred_time = session;
    if (intent === 'yoga' || decideLater) {
      patch.yoga_request = mergeYogaRequest(prior.yoga_request, yogaPatch);
    }
  }

  if (intent === 'meals' || (/\b(?:meal|meals|dinner)\b/i.test(text) && decideLater && prior.meals_request)) {
    const mealType = detectMealType(text) || (prior.meals_request && prior.meals_request.meal_type) || 'unspecified';
    const dayInfo = extractRequestedDays(text, prior.check_in, prior.check_out);
    const mealsPatch = {
      meal_type: mealType,
      status: decideLater ? 'interested' : resolveReactiveServiceStatus(
        !!(dayInfo && (dayInfo.mode === 'all_stay' || dayInfo.dates?.length || dayInfo.days?.length)),
        decideLater,
      ),
      deferred: decideLater || undefined,
    };
    if (dayInfo && dayInfo.mode === 'all_stay') {
      mealsPatch.requested_days = ['all_stay'];
    } else if (dayInfo && dayInfo.dates) {
      mealsPatch.requested_dates = dayInfo.dates;
    } else if (dayInfo && dayInfo.days) {
      mealsPatch.requested_days = dayInfo.days;
    }
    const dietary = extractDietaryNotes(text);
    if (dietary) mealsPatch.dietary_notes = dietary;
    if (intent === 'meals' || decideLater) {
      patch.meals_request = mergeMealsRequest(prior.meals_request, mealsPatch);
    }
  }

  if (decideLater) {
    if (prior.yoga_request) {
      patch.yoga_request = mergeYogaRequest(prior.yoga_request, { status: 'interested', deferred: true });
    }
    if (prior.meals_request) {
      patch.meals_request = mergeMealsRequest(prior.meals_request, { status: 'interested', deferred: true });
    }
  }

  if (decideLater && !intent) {
    if (prior.yoga_request && /\b(?:yoga)\b/i.test(text)) {
      patch.yoga_request = mergeYogaRequest(prior.yoga_request, { status: 'interested', deferred: true });
    }
    if (prior.meals_request && /\b(?:meal|meals|dinner|dinners)\b/i.test(text)) {
      patch.meals_request = mergeMealsRequest(prior.meals_request, { status: 'interested', deferred: true });
    }
  }

  if (!intent && prior.meals_request && mealsNeedsDayDetails(prior.meals_request)) {
    const dayInfo = extractRequestedDays(text, prior.check_in, prior.check_out);
    if (dayInfo) {
      const mealsPatch = { status: 'needs_staff_confirmation' };
      if (dayInfo.mode === 'all_stay') mealsPatch.requested_days = ['all_stay'];
      else if (dayInfo.dates) mealsPatch.requested_dates = dayInfo.dates;
      else if (dayInfo.days) mealsPatch.requested_days = dayInfo.days;
      patch.meals_request = mergeMealsRequest(prior.meals_request, mealsPatch);
    }
  }

  if (!intent && prior.yoga_request && yogaNeedsSessionDetails(prior.yoga_request)) {
    const dayInfo = extractRequestedDays(text, prior.check_in, prior.check_out);
    const session = extractYogaSessionHint(text);
    if (dayInfo || session) {
      const yogaPatch = { status: 'needs_staff_confirmation' };
      if (dayInfo && dayInfo.dates) yogaPatch.requested_dates = dayInfo.dates;
      if (dayInfo && dayInfo.days) yogaPatch.requested_days = dayInfo.days;
      if (session) yogaPatch.preferred_time = session;
      patch.yoga_request = mergeYogaRequest(prior.yoga_request, yogaPatch);
    }
  }

  if (ctx.guest_count != null && patch.meals_request && patch.meals_request.guest_count == null) {
    patch.meals_request.guest_count = ctx.guest_count;
  }
  if (ctx.guest_count != null && patch.yoga_request && patch.yoga_request.guest_count == null) {
    patch.yoga_request.guest_count = ctx.guest_count;
  }

  return patch;
}

function buildReactiveReturnTail(fields, lang, quote) {
  const range = formatStayRange(fields.check_in, fields.check_out);
  const guestPhrase = formatGuestPhrase(lang || 'en', fields.guest_count);
  const ctx = range && guestPhrase ? `${range} for ${guestPhrase}` : (range || guestPhrase || '');

  if (quoteAwaitingAddonsDecision(quote)) {
    if (ctx) {
      return `For your booking, I have ${ctx}. Are you going to need anything else, or should I keep going with the booking?`;
    }
    return 'Are you going to need anything else, or should I keep going with the booking?';
  }
  return 'Want me to keep going with your booking?';
}

function buildReactiveYogaReply(lang, fields, quote) {
  const req = fields.yoga_request || {};
  const L = trimStr(lang).slice(0, 2) || 'en';
  const opening = L === 'de'
    ? 'Ja — ich notiere Yoga für deinen Aufenthalt.'
    : 'Yes, I\'ll note yoga for your stay.';
  const tail = buildReactiveReturnTail(fields, lang, quote);
  return tail ? `${opening} ${tail}` : opening;
}

function buildReactiveMealsReply(lang, fields, quote) {
  const req = fields.meals_request || {};
  const L = trimStr(lang).slice(0, 2) || 'en';
  const mealLabel = req.meal_type === 'breakfast' ? 'breakfast'
    : req.meal_type === 'lunch' ? 'lunch'
      : req.meal_type === 'all' ? 'meals' : 'dinners';
  if (mealsNeedsDayDetails(req) && !req.deferred) {
    return L === 'de'
      ? `Ja — ich kann ${mealLabel === 'meals' ? 'Mahlzeiten' : mealLabel} für deinen Aufenthalt notieren. Für welche Tage?`
      : `Yes, I can note ${mealLabel} for your stay. Which days would you like ${mealLabel} for?`;
  }
  const opening = L === 'de'
    ? `Ja — ich notiere ${mealLabel === 'meals' ? 'Mahlzeiten' : mealLabel} für deinen Aufenthalt.`
    : `Yes, I can note ${mealLabel} for your stay.`;
  const tail = buildReactiveReturnTail(fields, lang, quote);
  return tail ? `${opening} ${tail}` : opening;
}

function buildReactiveServiceComposerReply(lang, intent, fields, quote) {
  if (intent === 'yoga') return buildReactiveYogaReply(lang, fields, quote);
  if (intent === 'meals') return buildReactiveMealsReply(lang, fields, quote);
  return null;
}

function buildReactiveServicesObservability(fields, clientSlug) {
  const f = fields || {};
  const meals = f.meals_request && typeof f.meals_request === 'object' ? f.meals_request : null;
  const yoga = f.yoga_request && typeof f.yoga_request === 'object' ? f.yoga_request : null;
  const config = readPricingConfig(clientSlug);
  const servicesRequested = [];
  if (meals) servicesRequested.push('meals');
  if (yoga) servicesRequested.push('yoga');

  const pendingManual = [];
  const scheduled = [];
  if (meals) {
    if (meals.status === 'scheduled') scheduled.push('meals');
    else if (meals.status === 'needs_staff_confirmation' || meals.status === 'requested' || meals.status === 'interested') {
      pendingManual.push('meals');
    }
  }
  if (yoga) {
    if (yoga.status === 'scheduled') scheduled.push('yoga');
    else if (yoga.status === 'needs_staff_confirmation' || yoga.status === 'requested' || yoga.status === 'interested') {
      pendingManual.push('yoga');
    }
  }

  const scheduling = resolveGuestSchedulingCapability();

  return {
    meals_status: meals ? (meals.status || 'requested') : 'not_requested',
    meal_type: meals ? (meals.meal_type || null) : null,
    meals_requested_dates: meals && Array.isArray(meals.requested_dates) ? meals.requested_dates : null,
    yoga_status: yoga ? (yoga.status || 'requested') : 'not_requested',
    yoga_requested_dates: yoga && Array.isArray(yoga.requested_dates) ? yoga.requested_dates : null,
    services_requested: servicesRequested.length ? servicesRequested : null,
    services_pending_manual: pendingManual.length ? pendingManual : null,
    services_scheduled: scheduled.length ? scheduled : null,
    reactive_scheduling_source: scheduling.staff_schedule_module,
    reactive_guest_attach_available: scheduling.guest_attach_available,
    pricing_config_loaded: !!config,
  };
}

function isReactiveServiceFollowUpMessage(text, priorFields) {
  const prior = priorFields || {};
  if (!prior.meals_request && !prior.yoga_request) return false;
  const t = String(text || '');
  if (detectReactiveServiceIntent(t) || guestDecidedLater(t)) return false;
  const hasDaySignal = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|all\s+(?:nights|days|stay))\b/i.test(t)
    || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/i.test(t);
  return hasDaySignal;
}

module.exports = {
  guestDecidedLater,
  isReactiveServiceMessage,
  isReactiveServiceFollowUpMessage,
  detectReactiveServiceIntent,
  detectMealType,
  extractReactiveServicesFromMessage,
  mergeMealsRequest,
  mergeYogaRequest,
  mealsNeedsDayDetails,
  yogaNeedsSessionDetails,
  buildReactiveReturnTail,
  buildReactiveYogaReply,
  buildReactiveMealsReply,
  buildReactiveServiceComposerReply,
  buildReactiveServicesObservability,
  resolveGuestSchedulingCapability,
};
