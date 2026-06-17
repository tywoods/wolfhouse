'use strict';

/**
 * Stage 28k — Luna booking intake flow policy.
 *
 * Centralizes booking information collection order, out-of-order extraction,
 * room-preference decisions, and transfer-info status. Pure logic — no writes.
 */

const { computeStayNights, isWeeklySurfPackage, isAccommodationOnlyIntent } = require('./wolfhouse-package-night-rules');
const {
  extractLunaGuestMessageIntake,
  inferCheckoutDayFromPriorCheckIn,
  parseGuestNameAnswer,
  detectStayAccommodationOnlyText,
} = require('./luna-guest-message-intake');
const {
  guestDeclinedAddons,
  paymentChoiceDeclinesPendingAddons,
  extractAddOnSelections,
  quoteAwaitingAddonsDecision,
  resolveAddOnsStatus,
} = require('./luna-booking-addons-policy');
const { extractReactiveServicesFromMessage } = require('./luna-booking-reactive-services-policy');
const {
  UNISEX_NAMES,
  LIKELY_MALE_NAMES,
  LIKELY_FEMALE_NAMES,
} = require('./luna-guest-gender-names');

const INTAKE_FIELD_ORDER = Object.freeze([
  'dates',
  'guest_count',
  'guest_name',
  'stay_type',
]);

const POST_QUOTE_FIELD_ORDER = Object.freeze([
  'group_composition',
  'room_preference',
  'add_ons',
  'transfer_info',
  'payment_choice',
]);

const GENERIC_WHATSAPP_NAMES = new Set([
  'guest', 'user', 'whatsapp user', 'unknown', 'contact', 'friend',
  'there', 'me', 'n/a', 'na', 'none',
]);

const NO_ADDONS_RE = /\b(?:no\s+thanks?|just\s+the\s+stay|accommodation\s+only|i\s+have\s+my\s+own(?:\s+stuff)?|no\s+add(?:\s+|-)?nothing|nothing\s+else|nothing\s+extra|no\s+extras?|no\s+wetsuit|no\s+board|no\s+lesson)\b/i;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function hasDates(fields) {
  return !!(fields && fields.check_in && fields.check_out);
}

function hasCollectedGuestName(fields, channelName) {
  const n = trimStr(fields && fields.guest_name);
  if (n && !isGenericWhatsAppName(n)) return true;
  const ch = trimStr(channelName);
  return ch.length > 0 && !isGenericWhatsAppName(ch);
}

function effectiveGuestName(fields, channelName) {
  const n = trimStr(fields && fields.guest_name);
  if (n && !isGenericWhatsAppName(n)) return n;
  const ch = trimStr(channelName);
  if (ch && !isGenericWhatsAppName(ch)) return ch;
  return n || ch || '';
}

function isGenericWhatsAppName(name) {
  const n = trimStr(name).toLowerCase();
  if (!n) return true;
  if (GENERIC_WHATSAPP_NAMES.has(n)) return true;
  if (/^\+?\d[\d\s\-()]{6,}$/.test(n)) return true;
  if (n.length <= 1) return true;
  return false;
}

function firstNameOf(fullName) {
  const parts = trimStr(fullName).split(/\s+/).filter(Boolean);
  return parts[0] ? parts[0].toLowerCase() : '';
}

function inferLikelyGuestGender(guestName) {
  const first = firstNameOf(guestName);
  if (!first) return 'unknown';
  if (UNISEX_NAMES.has(first)) return 'unknown';
  if (LIKELY_FEMALE_NAMES.has(first)) return 'female';
  if (LIKELY_MALE_NAMES.has(first)) return 'male';
  return 'unknown';
}

function normalizeGroupGender(value) {
  const v = trimStr(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!v) return null;
  if (v === 'female' || v === 'female_only' || v === 'girls' || v === 'girls_room' || v === 'all_girls') {
    return 'female';
  }
  if (v === 'male' || v === 'male_only' || v === 'guys' || v === 'guys_room' || v === 'all_guys' || v === 'all_men') {
    return 'male';
  }
  if (v === 'mixed' || v === 'mix') return 'mixed';
  return null;
}

function groupGenderFromFields(fields) {
  const f = fields || {};
  return normalizeGroupGender(f.group_gender)
    || normalizeGroupGender(f.gender_preference)
    || null;
}

function groupCompositionResolved(state) {
  const fields = (state && state.extracted_fields) || {};
  const guestCount = fields.guest_count != null ? Number(fields.guest_count) : null;
  if (guestCount == null || guestCount < 2) return true;
  return !!groupGenderFromFields(fields);
}

/**
 * Parse group composition from guest reply (groups of 2+ only).
 * @returns {'female'|'male'|'mixed'|null}
 */
function parseGroupCompositionAnswer(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  if (/\b(?:all\s+)?girls?\b|\ball\s+females?\b|\b(?:solo|only)\s+(?:girls?|women|females?)\b|\bchicas?\b|\bchicas\b|\bmujeres\b|\balle\s+ragazze\b|\btoutes?\s+filles?\b|\bmädchen\b|\bmadchen\b|\bfilles?\b/i.test(t)
    && !/\b(?:mix|mixed|guys?|boys?|men|hombres|ragazzi)\b/i.test(t)) {
    return 'female';
  }
  if (/\b(?:all\s+)?guys?\b|\ball\s+boys?\b|\ball\s+men\b|\b(?:solo|only)\s+(?:guys?|boys?|men)\b|\btutti\s+ragazzi\b|\btodos\s+(?:chicos?|hombres)\b|\btous\s+les\s+hommes\b|\balle\s+jungs\b|\bhombres\b|\bchicos?\b/i.test(t)
    && !/\b(?:mix|mixed|girls?|women|females?|chicas)\b/i.test(t)) {
    return 'male';
  }
  if (/\b(?:mix(?:ed)?|a\s+mix|mezcla|misto|gemischt|mixte)\b/i.test(t)
    || /\b(?:girls?\s+and\s+guys?|boys?\s+and\s+girls?|men\s+and\s+women)\b/i.test(t)) {
    return 'mixed';
  }
  return null;
}

function inferGroupCompositionNeed(state, context) {
  const fields = (state && state.extracted_fields) || {};
  const guestCount = fields.guest_count != null ? Number(fields.guest_count) : null;
  if (guestCount == null || guestCount < 2) {
    return { needed: false, question_type: null, rule_applied: 'solo_no_composition' };
  }
  if (groupGenderFromFields(fields)) {
    return { needed: false, question_type: null, rule_applied: 'group_composition_already_set' };
  }
  return {
    needed: true,
    question_type: 'group_composition',
    rule_applied: 'group_always_ask_composition',
    block_booking: false,
  };
}

function normalizeStayType(fields, packageNightRule) {
  const pi = trimStr(fields && fields.package_interest).toLowerCase();
  if (isWeeklySurfPackage(pi)) return pi;
  if (pi === 'accommodation_only' || pi === 'no_package' || pi === 'custom') return 'accommodation_only';
  if (packageNightRule === 'short_stay_accommodation') return 'accommodation_only';
  if (packageNightRule === 'weekly_explain_before_choice') return 'undecided';
  return pi || null;
}

function isPackageBooking(stayType, fields) {
  const st = stayType || normalizeStayType(fields);
  return isWeeklySurfPackage(st);
}

function detectTransferDeclined(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  return /\b(?:no\s+transfer|without\s+transfer|don'?t\s+need(?:\s+a)?\s+transfer|do\s+not\s+need(?:\s+a)?\s+transfer|no\s+shuttle|without\s+shuttle|own\s+transport|i'?ll?\s+(?:get|arrange)\s+(?:my\s+own|there)|we'?ll?\s+drive|no\s+pickup|no\s+pick\s+up)\b/i.test(t)
    || /^(?:no|nope|nah)(?:\s+thanks?)?$/i.test(t);
}

/** Guest signals they are done adding details — proceed to deposit/payment. */
function detectBookingReadyToProceed(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (detectTransferDeclined(t)) return false;
  return /\b(?:that'?s\s+it|thats\s+it|that\s+is\s+it|nothing\s+else|no\s+that'?s\s+all|that'?s\s+all|all\s+good|all\s+set|good\s+to\s+go|ready\s+to\s+(?:book|pay|proceed)|let'?s\s+(?:book|do\s+it|finalize|finalise)|book\s+it|finalize|finalise)\b/i.test(t)
    || /\b(?:for\s+now|that'?s\s+all\s+for\s+now|that'?s\s+it\s+for\s+now)\b/i.test(t)
    || /^(?:nothing|nothing else|no nothing|nope nothing)[\s.!]*$/i.test(t);
}

function detectTransferAffirmative(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (detectTransferDeclined(t)) return false;
  if (/\b(?:transfer|shuttle|airport|pick.?up|pickup)\b/i.test(t)
    && /\b(?:yes|yeah|yep|sure|please|need|book|want|would\s+like)\b/i.test(t)) {
    return true;
  }
  return /^(?:yes|yeah|yep|sure|please)$/i.test(t);
}

function parseColloquialTimeToken(raw) {
  const w = trimStr(raw).toLowerCase();
  if (!w) return null;
  if (w === 'noon' || w === 'midday') return '12:00';
  if (w === 'morning') return '09:00';
  const m = w.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] != null ? Number(m[2]) : 0;
  const mer = m[3] ? m[3].toLowerCase() : null;
  if (mer === 'pm' && hh < 12) hh += 12;
  if (mer === 'am' && hh === 12) hh = 0;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function extractTransferInfo(text) {
  const t = String(text || '');
  if (detectTransferDeclined(t)) {
    return { interested: false };
  }
  const hasTransferCue = /\b(?:transfer|airport|aeropuerto|aeroporto|flughafen|aéroport|aeroport|pick.?up|flight|lands?|arriv|depart|fly\s+into|shuttle)\b/i.test(t)
    || /\b(?:Santander|Bilbao|SDR|BIO)\b/i.test(t);
  const hasTimingCue = /\b(?:arriv\w*|land\w*|leave|leaving|depart\w*|check[\s-]?in|check[\s-]?out)\b/i.test(t)
    && /\b(?:noon|midday|morning|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(t);
  if (!hasTransferCue && !hasTimingCue) {
    if (detectTransferAffirmative(t)) return { interested: true };
    return null;
  }
  const lower = t.toLowerCase();
  const info = { interested: true };
  if (/\bbilbao\b|\bBIO\b/i.test(t)) info.airport_code = 'BIO';
  else if (/\bsantander\b|\bSDR\b/i.test(t)) info.airport_code = 'SDR';
  if (/\b(?:arrival|arrivo|llegada|arrivée|arrivee|ankunft|lands?|fly\s+into)\b/i.test(lower)) {
    info.direction = 'arrival';
  }
  if (/\b(?:departure|partenza|salida|départ|depart|abflug)\b/i.test(lower)) {
    info.direction = 'departure';
  }
  const landMatch = t.match(/\b(?:land(?:ing)?|arriv(?:e|al|ing)?|touch(?:ing)?\s+down)\b[^.?!]{0,40}?(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i)
    || t.match(/\b(?:arrival|arrive)\b[^.?!]{0,20}?(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  const leaveMatch = t.match(/\b(?:leave|leaving|depart(?:ure|ing)?|fly(?:ing)?\s+out)\b[^.?!]{0,40}?(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i)
    || t.match(/\b(?:departure|depart)\b[^.?!]{0,20}?(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (landMatch) info.arrival_time = trimStr(landMatch[1]);
  if (leaveMatch) info.departure_time = trimStr(leaveMatch[1]);
  if (!info.arrival_time && !info.departure_time) {
    const timeMatch = t.match(/\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)
      || t.match(/\b(\d{1,2}:\d{2})\b/);
    if (timeMatch) {
      if (info.direction === 'departure') info.departure_time = trimStr(timeMatch[1]);
      else info.arrival_time = trimStr(timeMatch[1]);
    }
  }
  const arriveDay = t.match(/\b(?:arriv\w*|land\w*|get\s+in)\b[^.?!]{0,60}?\b(?:at\s+)?(noon|midday|morning|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  const leaveDay = t.match(/\b(?:leave|leaving|depart\w*)\b[^.?!]{0,60}?\b(?:at\s+)?(noon|midday|morning|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (arriveDay && !info.arrival_time) {
    const parsed = parseColloquialTimeToken(arriveDay[1]);
    if (parsed) info.arrival_time = parsed;
  }
  if (leaveDay && !info.departure_time) {
    const parsed = parseColloquialTimeToken(leaveDay[1]);
    if (parsed) info.departure_time = parsed;
  }
  if (/\b(?:later|send.*later|don'?t know yet|not sure yet)\b/i.test(lower)) {
    info.deferred = true;
  }
  const flight = t.match(/\b([A-Z]{2}\s?\d{2,4})\b/i);
  if (flight) info.flight_number = flight[1].replace(/\s+/g, '').toUpperCase();
  return info;
}

const CONTINUATION_COUNT_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

function extractGuestCountFromText(text) {
  const intake = extractLunaGuestMessageIntake(
    { client_slug: 'wolfhouse-somo', message_text: text },
    {},
  );
  if (intake.guests != null) return intake.guests;
  const t = trimStr(text).toLowerCase();
  const bare = t.match(/^(\d{1,2})$/);
  if (bare) {
    const n = Number(bare[1]);
    if (n >= 1 && n <= 24) return n;
  }
  const pleaseNum = t.match(/^(\d{1,2})\s+please$/);
  if (pleaseNum) return Number(pleaseNum[1]);
  const forWord = t.match(/^for\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i);
  if (forWord) return CONTINUATION_COUNT_WORDS[forWord[1].toLowerCase()] || null;
  const people = t.match(/^(\d{1,2})\s+(?:people|guests?|persons|ppl)$/i);
  if (people) return Number(people[1]);
  const guestN = t.match(/\b(\d{1,2})\s+guest\b/i);
  if (guestN) return Number(guestN[1]);
  const ofUs = t.match(/\b(\d{1,2})\s+of\s+us\b/i);
  if (ofUs) return Number(ofUs[1]);
  const weAre = t.match(/\b(?:we are|we're|wir sind|siamo|somos|nous sommes)\s+(\d{1,2})\b/i);
  if (weAre) return Number(weAre[1]);
  const sindWir = t.match(/\b(?:sind wir|siamo in|somos)\s+(\d{1,2})\b/i);
  if (sindWir) return Number(sindWir[1]);
  if (/^(?:me|just\s+me|only\s+me)$/i.test(t)) return 1;
  if (/\btwo\s+of\s+us\b/i.test(t)) return 2;
  if (/\bme\s+and\s+my\s+friend\b/i.test(t)) return 2;
  return null;
}

function extractNameFromText(text) {
  const direct = parseGuestNameAnswer(text);
  if (direct) return direct;
  const t = String(text || '');
  if (/\b(?:paket|package|paquete|enthalten|inclus|included|incluye)\b/i.test(t)) return null;
  const im = t.match(/\b(?:i'?m|i\s+am)\s+([a-z][a-z'\- ]{0,40})/i);
  if (im) return trimStr(im[1]);
  const hi = t.match(/\bhi[,!]?\s+i'?m\s+([a-z][a-z'\- ]{0,40})/i);
  if (hi) return trimStr(hi[1]);
  return null;
}

function mergeTransferInfo(prior, next) {
  if (!next) return prior || null;
  if (next.interested === false) return { interested: false };
  const p = prior && typeof prior === 'object' ? { ...prior } : {};
  if (p.interested === false) return { interested: false };
  const merged = { ...p, ...next, interested: next.interested !== false };
  if (next.direction === 'departure' && next.arrival_time && !merged.departure_time) {
    merged.departure_time = next.arrival_time;
  }
  return merged;
}


/** Guest count can be stored without a collected name when the message already carries booking context. */
function shouldDeferGuestCount(prior, patch, text, channelName) {
  if (hasCollectedGuestName({ ...(prior || {}), ...(patch || {}) }, channelName)) return false;
  if (patch && patch.package_interest) return false;
  if (prior && prior.package_interest) return false;
  if (patch && patch.check_in && patch.check_out) return false;
  if (prior && prior.check_in && prior.check_out) return false;
  if (/\b(?:malibu|uluwatu|waimea|surf\s+package|package|people|guests?|ppl|persons?|personnes|personas|gäste|gaste|ospiti)\b/i.test(String(text || ''))) {
    return false;
  }
  return true;
}

function addonsResolved(state) {
  const st = state || {};
  if (st.add_ons_status === 'declined' || st.add_ons_status === 'collected') return true;
  const addons = st.extracted_fields && st.extracted_fields.service_interest;
  if (Array.isArray(addons) && addons.length > 0) return true;
  if (st.extracted_fields && st.extracted_fields.addons_skipped === true) return true;
  return false;
}

function roomPreferenceResolved(state) {
  const rp = state && state.extracted_fields && state.extracted_fields.room_preference;
  return trimStr(rp).length > 0 || state.room_preference_status === 'skipped';
}

function privateRoomAvailable(availability) {
  const av = availability || {};
  if (av.private_room_available === true) return true;
  if (av.room_options && av.room_options.private_available === true) return true;
  const note = trimStr(av.availability_note && av.availability_note.message).toLowerCase();
  return note.includes('private available');
}

function girlsRoomAvailable(availability) {
  const av = availability || {};
  if (av.girls_room_available === false) return false;
  if (av.girls_room_available === true) return true;
  return false;
}

/**
 * @param {object} state
 * @param {object} [context]
 * @returns {object}
 */
function inferRoomPreferenceNeed(state, context) {
  const ctx = context || {};
  const fields = (state && state.extracted_fields) || {};
  const guestCount = fields.guest_count != null ? Number(fields.guest_count) : null;
  const availability = ctx.availability || state.availability || {};
  const privateAvail = privateRoomAvailable(availability);
  const girlsAvail = girlsRoomAvailable(availability);
  const groupGender = groupGenderFromFields(fields);

  if (guestCount == null || guestCount < 1) {
    return {
      needed: false,
      question_type: null,
      rule_applied: 'guest_count_unknown',
      block_booking: false,
    };
  }

  if (guestCount >= 2 && !groupGender) {
    return {
      needed: false,
      question_type: null,
      rule_applied: 'awaiting_group_composition',
      block_booking: false,
    };
  }

  if (guestCount === 1) {
    const gender = inferLikelyGuestGender(effectiveGuestName(fields, ctx.channel_guest_name));
    if (gender === 'male') {
      return {
        needed: false,
        question_type: null,
        rule_applied: 'solo_male_default_mixed',
        block_booking: false,
      };
    }
    if (!girlsAvail) {
      return {
        needed: false,
        question_type: null,
        rule_applied: 'solo_no_girls_room_auto_assign',
        block_booking: false,
      };
    }
    if (gender === 'female') {
      return {
        needed: true,
        question_type: 'girls_or_mixed',
        rule_applied: 'solo_female_girls_mixed',
        block_booking: false,
      };
    }
    return {
      needed: true,
      question_type: 'neutral_shared',
      rule_applied: 'solo_unknown_neutral',
      block_booking: false,
    };
  }

  if (guestCount === 2) {
    if (groupGender === 'mixed') {
      return {
        needed: false,
        question_type: null,
        rule_applied: 'pair_mixed_default_shared',
        block_booking: false,
      };
    }
    if (groupGender === 'male') {
      if (privateAvail) {
        return {
          needed: true,
          question_type: 'private_or_shared',
          rule_applied: 'pair_male_private_option',
          block_booking: false,
          private_extra_eur_per_night: 10,
        };
      }
      return {
        needed: false,
        question_type: null,
        rule_applied: 'pair_male_default_shared',
        block_booking: false,
      };
    }
    if (groupGender === 'female') {
      if (privateAvail && girlsAvail) {
        return {
          needed: true,
          question_type: 'pair_female_room_options',
          rule_applied: 'pair_female_private_girls_mixed',
          block_booking: false,
          private_extra_eur_per_night: 10,
        };
      }
      if (girlsAvail) {
        return {
          needed: true,
          question_type: 'girls_or_mixed',
          rule_applied: 'pair_female_girls_mixed',
          block_booking: false,
        };
      }
      if (privateAvail) {
        return {
          needed: true,
          question_type: 'private_or_shared',
          rule_applied: 'pair_female_private_only',
          block_booking: false,
          private_extra_eur_per_night: 10,
        };
      }
      return {
        needed: false,
        question_type: null,
        rule_applied: 'pair_female_auto_assign',
        block_booking: false,
      };
    }
  }

  if (guestCount >= 3) {
    if (groupGender === 'female' && girlsAvail) {
      return {
        needed: true,
        question_type: 'girls_or_mixed',
        rule_applied: 'group_female_girls_or_mixed',
        block_booking: false,
      };
    }
    return {
      needed: false,
      question_type: null,
      rule_applied: 'group_default_assignment',
      block_booking: false,
    };
  }

  return {
    needed: false,
    question_type: null,
    rule_applied: 'default_assignment',
    block_booking: false,
  };
}

function resolveTransferInfoStatus(state, context) {
  const fields = (state && state.extracted_fields) || {};
  const stayType = normalizeStayType(fields, state && state.package_night_rule);
  const transfer = fields.transfer_info || fields.transfer_interest || null;
  const ctxTransfer = context && context.transfer_info;

  if (!isPackageBooking(stayType, fields)) {
    if (transfer || ctxTransfer) return 'noted_accommodation_only';
    return 'not_applicable';
  }

  const merged = mergeTransferInfo(transfer, ctxTransfer);
  if (!merged) return 'optional_pending';
  if (merged.interested === false) return 'not_needed';
  if (merged.deferred === true) return 'deferred';
  if (merged.airport_code) return 'complete';
  if (merged.arrival_time || merged.departure_time || merged.flight_number) return 'partial';
  if (merged.interested === true) return 'partial';
  return 'optional_pending';
}

/**
 * @param {object} state
 * @param {object} [context]
 * @returns {string[]}
 */
function determineRequiredBookingFields(state, context) {
  const ctx = context || {};
  const fields = (state && state.extracted_fields) || {};
  const missing = [];

  if (!hasDates(fields)) missing.push('dates');
  if (fields.guest_count == null || fields.guest_count < 1) missing.push('guest_count');

  const nights = computeStayNights(fields.check_in, fields.check_out);
  const stayType = normalizeStayType(fields, state && state.package_night_rule);
  if (hasDates(fields) && fields.guest_count >= 1 && hasCollectedGuestName(fields, ctx.channel_guest_name)) {
    if (nights != null && nights >= 7 && !stayType
      && (state && state.package_night_rule === 'weekly_explain_before_choice')) {
      missing.push('stay_type');
    }
  }

  const quoteReady = ctx.quote && ctx.quote.quote_status === 'ready';
  if (quoteReady) {
    if (!addonsResolved(state) && quoteAwaitingAddonsDecision(ctx.quote)) {
      missing.push('add_ons');
    }
    const compNeed = inferGroupCompositionNeed(state, ctx);
    if (compNeed.needed && !groupCompositionResolved(state)) {
      missing.push('group_composition');
    }
    const roomNeed = inferRoomPreferenceNeed(state, ctx);
    if (roomNeed.needed && !roomPreferenceResolved(state) && addonsResolved(state)
      && groupCompositionResolved(state)) {
      missing.push('room_preference');
    }
    if (isPackageBooking(stayType, fields)) {
      const ts = resolveTransferInfoStatus(state, ctx);
      if (ts === 'optional_pending') missing.push('transfer_info');
    }
    if (ctx.quote.payment_choice_needed === true
      && !(ctx.payment_choice && ctx.payment_choice.payment_choice_ready)) {
      if (!hasCollectedGuestName(fields, ctx.channel_guest_name)) missing.push('guest_name');
      missing.push('payment_choice');
    }
  }

  return missing;
}

function mapFieldToQuestion(field, state, context) {
  const ctx = context || {};
  const fields = (state && state.extracted_fields) || {};
  const roomNeed = inferRoomPreferenceNeed(state, ctx);

  switch (field) {
    case 'dates':
      return { question: 'ask_dates', stage: 'collecting_dates', field: 'dates' };
    case 'guest_name':
      return { question: 'ask_guest_name', stage: 'collecting_name', field: 'guest_name' };
    case 'guest_count':
      return { question: 'ask_guests', stage: 'collecting_guest_count', field: 'guest_count' };
    case 'stay_type':
      return { question: 'ask_stay_type', stage: 'collecting_stay_type', field: 'stay_type' };
    case 'group_composition':
      return { question: 'ask_group_composition', stage: 'group_composition', field: 'group_composition' };
    case 'room_preference':
      if (roomNeed.question_type === 'pair_female_room_options') {
        return { question: 'ask_pair_female_room_options', stage: 'room_preference', field: 'room_preference' };
      }
      if (roomNeed.question_type === 'private_or_shared') {
        return { question: 'ask_room_preference_private_shared', stage: 'room_preference', field: 'room_preference' };
      }
      if (roomNeed.question_type === 'girls_or_mixed' || roomNeed.question_type === 'mixed_only_female') {
        return { question: 'ask_room_preference_girls_mixed', stage: 'room_preference', field: 'room_preference' };
      }
      return { question: 'ask_room_preference_neutral', stage: 'room_preference', field: 'room_preference' };
    case 'add_ons':
      return { question: 'ask_addons_after_quote', stage: 'add_ons', field: 'add_ons' };
    case 'transfer_info':
      return { question: 'ask_transfer_info_casual', stage: 'transfer_info', field: 'transfer_info' };
    case 'payment_choice':
      return { question: 'ask_payment_choice', stage: 'payment_choice', field: 'payment_choice' };
    default:
      return { question: null, stage: 'unknown', field };
  }
}

/**
 * @param {object} state
 * @param {object} [context]
 * @returns {object}
 */
function determineNextBookingQuestion(state, context) {
  const ctx = context || {};
  const fields = (state && state.extracted_fields) || {};
  const quote = ctx.quote || {};
  const missing = determineRequiredBookingFields(state, ctx);

  if (quote.quote_status === 'ready' && missing.includes('add_ons')) {
    return mapFieldToQuestion('add_ons', state, ctx);
  }
  if (quote.quote_status === 'ready' && missing.includes('group_composition')) {
    return mapFieldToQuestion('group_composition', state, ctx);
  }
  if (quote.quote_status === 'ready' && missing.includes('room_preference')) {
    return mapFieldToQuestion('room_preference', state, ctx);
  }
  if (quote.quote_status === 'ready' && missing.includes('guest_name')) {
    return mapFieldToQuestion('guest_name', state, ctx);
  }
  if (quote.quote_status === 'ready' && missing.includes('transfer_info')) {
    return mapFieldToQuestion('transfer_info', state, ctx);
  }
  if (quote.quote_status === 'ready' && missing.includes('payment_choice')) {
    return mapFieldToQuestion('payment_choice', state, ctx);
  }

  for (const field of INTAKE_FIELD_ORDER) {
    if (missing.includes(field)) return mapFieldToQuestion(field, state, ctx);
  }
  if (missing.includes('stay_type')) return mapFieldToQuestion('stay_type', state, ctx);

  if (quote.quote_status === 'ready') {
    return { question: 'quote_ready', stage: 'quote_ready', field: null };
  }
  if (hasDates(fields) && fields.guest_count >= 1 && hasCollectedGuestName(fields, ctx.channel_guest_name)) {
    return { question: 'check_availability', stage: 'availability_check', field: null };
  }
  return { question: null, stage: 'intake_complete', field: null };
}

/**
 * Extract all booking fields from a single message (out-of-order tolerant).
 */
function normalizeOutOfOrderBookingInfo(message, priorState, context) {
  const prior = (priorState && priorState.extracted_fields) || {};
  const ctx = context || {};
  const text = trimStr(message);
  const intake = extractLunaGuestMessageIntake(
    {
      client_slug: 'wolfhouse-somo',
      message_text: text,
      guest_name: ctx.channel_guest_name || null,
      from: ctx.guest_phone || null,
    },
    { reference_date: ctx.reference_date },
  );

  const patch = {};
  if (intake.check_in) patch.check_in = intake.check_in;
  if (intake.check_out) patch.check_out = intake.check_out;
  const guestsEarly = extractGuestCountFromText(text);
  const priorHasCheckout = trimStr(prior.check_out) !== '';
  const answeringGuestCount = guestsEarly != null && priorHasCheckout && !intake.check_in && !intake.check_out;
  if (!patch.check_out && !priorHasCheckout && (patch.check_in || prior.check_in) && !answeringGuestCount) {
    const inferredOut = inferCheckoutDayFromPriorCheckIn(
      text,
      patch.check_in || prior.check_in,
      ctx.reference_date,
    );
    if (inferredOut) patch.check_out = inferredOut;
  }
  if (intake.package_code) patch.package_interest = intake.package_code;

  const name = extractNameFromText(text);
  if (name && !isGenericWhatsAppName(name) && !guestDeclinedAddons(text)) {
    patch.guest_name = name;
  }

  const guests = guestsEarly != null ? guestsEarly : extractGuestCountFromText(text);
  if (guests != null) {
    if (!shouldDeferGuestCount(prior, patch, text, ctx.channel_guest_name)) {
      patch.guest_count = guests;
    } else {
      patch.deferred_guest_count = guests;
    }
  }

  if (Array.isArray(intake.add_ons) && intake.add_ons.length) {
    const surfOnly = intake.add_ons.filter((code) => ['wetsuit', 'surfboard', 'surf_lesson'].includes(code));
    if (surfOnly.length) patch.service_interest = surfOnly;
  }
  const addonSelections = extractAddOnSelections(text);
  if (addonSelections.length) {
    patch.service_interest = addonSelections;
  }
  if (guestDeclinedAddons(text)) {
    patch.addons_skipped = true;
    patch.service_interest = [];
  }

  const reactivePatch = extractReactiveServicesFromMessage(text, { ...prior, ...patch }, {
    guest_count: patch.guest_count != null ? patch.guest_count : prior.guest_count,
  });
  if (reactivePatch.meals_request) patch.meals_request = reactivePatch.meals_request;
  if (reactivePatch.yoga_request) patch.yoga_request = reactivePatch.yoga_request;

  if (detectStayAccommodationOnlyText(text)) {
    patch.package_interest = 'accommodation_only';
  } else if (/\b(?:no package|not booking a package|sin paquete|sans forfait|ohne paket|without a package)\b/i.test(text)
    && !/\b(?:malibu|uluwatu|waimea)\b/i.test(text)) {
    if (!patch.package_interest) patch.package_interest = 'no_package';
  }

  const composition = parseGroupCompositionAnswer(text);
  if (composition) {
    patch.group_gender = composition;
    patch.gender_preference = composition;
  }

  const transfer = extractTransferInfo(text);
  if (transfer) patch.transfer_info = mergeTransferInfo(prior.transfer_info, transfer);

  if (detectBookingReadyToProceed(text)) {
    patch.booking_ready_to_proceed = true;
    if (!prior.addons_skipped && !patch.addons_skipped) patch.addons_skipped = true;
    const ti = patch.transfer_info || prior.transfer_info;
    if (ti && ti.interested === true && ti.airport_code && !ti.arrival_time && !ti.departure_time) {
      patch.transfer_info = { ...ti, times_default_ok: true };
    }
    if (!trimStr(prior.room_preference) && !trimStr(patch.room_preference)) {
      patch.room_preference = 'shared';
    }
  }

  const inferred = [];
  if (patch.guest_name) inferred.push('guest_name');
  if (patch.check_in && patch.check_out) inferred.push('dates');
  if (patch.guest_count != null) inferred.push('guest_count');
  if (patch.package_interest) inferred.push('stay_type');
  if (composition) inferred.push('group_composition');
  if (transfer) inferred.push('transfer_info');

  return {
    extracted_fields_patch: patch,
    inferred_fields: inferred,
    transfer_info: patch.transfer_info || null,
  };
}

function resolveAddOnsStatusLocal(state, context) {
  const fields = (state && state.extracted_fields) || {};
  const quote = (context && context.quote) || (state && state.quote) || {};
  return resolveAddOnsStatus(fields, quote);
}

function resolveBookingFlowStage(state, context) {
  const next = determineNextBookingQuestion(state, context);
  return next.stage || 'unknown';
}

function buildSkippedQuestions(state, context) {
  const skipped = [];
  const fields = (state && state.extracted_fields) || {};
  const ch = trimStr(context && context.channel_guest_name);
  if (ch && !isGenericWhatsAppName(ch) && trimStr(fields.guest_name) === ch) {
    skipped.push('guest_name');
  }
  const compNeed = inferGroupCompositionNeed(state, context);
  if (!compNeed.needed) skipped.push('group_composition');
  const roomNeed = inferRoomPreferenceNeed(state, context);
  if (!roomNeed.needed) skipped.push('room_preference');
  const ts = resolveTransferInfoStatus(state, context);
  if (ts === 'not_applicable' || ts === 'deferred' || ts === 'not_needed') {
    skipped.push('transfer_info_blocking');
  }
  return skipped;
}

function buildInferredFields(state, context) {
  const fields = (state && state.extracted_fields) || {};
  const out = {};
  const ch = trimStr(context && context.channel_guest_name);
  if (ch && !isGenericWhatsAppName(ch)) out.guest_name_from_whatsapp = true;
  const stay = normalizeStayType(fields, state && state.package_night_rule);
  if (stay) out.stay_type = stay;
  const nights = computeStayNights(fields.check_in, fields.check_out);
  if (nights != null && nights < 7) out.short_stay_accommodation_default = true;
  const guestCount = fields.guest_count != null ? Number(fields.guest_count) : null;
  const gender = inferLikelyGuestGender(effectiveGuestName(fields, ch));
  if (guestCount === 1 && gender !== 'unknown') out.likely_guest_gender = gender;
  return out;
}

/**
 * Build observability snapshot for router/orchestrator results.
 */
function buildBookingIntakePolicySnapshot(state, context) {
  const ctx = context || {};
  const roomNeed = inferRoomPreferenceNeed(state, ctx);
  const compNeed = inferGroupCompositionNeed(state, ctx);
  const next = determineNextBookingQuestion(state, ctx);
  return {
    booking_flow_stage: resolveBookingFlowStage(state, ctx),
    next_required_field: next.field,
    next_booking_question: next.question,
    required_fields: determineRequiredBookingFields(state, ctx),
    skipped_questions: buildSkippedQuestions(state, ctx),
    inferred_fields: buildInferredFields(state, ctx),
    group_composition_needed: compNeed.needed,
    group_composition_question_type: compNeed.question_type,
    group_composition_rule_applied: compNeed.rule_applied,
    room_preference_needed: roomNeed.needed,
    room_preference_question_type: roomNeed.question_type,
    room_preference_rule_applied: roomNeed.rule_applied,
    room_preference_block_booking: roomNeed.block_booking === true,
    transfer_info_status: resolveTransferInfoStatus(state, ctx),
    add_ons_status: resolveAddOnsStatusLocal(state, ctx),
    intake_field_order: [...INTAKE_FIELD_ORDER],
    post_quote_field_order: [...POST_QUOTE_FIELD_ORDER],
  };
}

function mapPolicyQuestionToComposerState(question) {
  const map = {
    ask_dates: 'ask_dates',
    ask_guest_name: 'ask_guest_name',
    ask_guests: 'ask_guests',
    ask_stay_type: 'ask_package',
    ask_addons_after_quote: 'ask_addons_after_quote',
    ask_payment_choice: 'ask_payment_choice',
    ask_room_preference_girls_mixed: 'ask_room_preference_girls_mixed',
    ask_room_preference_private_shared: 'ask_room_preference_private_shared',
    ask_room_preference_neutral: 'ask_room_preference_neutral',
    ask_group_composition: 'ask_group_composition',
    ask_pair_female_room_options: 'ask_pair_female_room_options',
    ask_transfer_info_casual: 'ask_transfer_info_casual',
  };
  return map[question] || null;
}

module.exports = {
  INTAKE_FIELD_ORDER,
  POST_QUOTE_FIELD_ORDER,
  determineRequiredBookingFields,
  determineNextBookingQuestion,
  inferRoomPreferenceNeed,
  inferGroupCompositionNeed,
  parseGroupCompositionAnswer,
  normalizeGroupGender,
  groupGenderFromFields,
  groupCompositionResolved,
  normalizeOutOfOrderBookingInfo,
  buildBookingIntakePolicySnapshot,
  mapPolicyQuestionToComposerState,
  resolveTransferInfoStatus,
  detectTransferDeclined,
  detectTransferAffirmative,
  detectBookingReadyToProceed,
  mergeTransferInfo,
  isGenericWhatsAppName,
  inferLikelyGuestGender,
  extractTransferInfo,
  extractGuestCountFromText,
  extractNameFromText,
  guestDeclinedAddons,
  paymentChoiceDeclinesPendingAddons,
  effectiveGuestName,
  hasCollectedGuestName,
  shouldDeferGuestCount,
};
