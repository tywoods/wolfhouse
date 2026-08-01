'use strict';

/**
 * Sunset guest automation turn (dry-run) — school-aware, isolated from Wolfhouse chain.
 * No outbound WhatsApp/email, no Stripe sends.
 * Waiver ensure only when booking_id + confirm_write/ensure_waiver (DB write to waiver tables).
 */

const { normalizeGuestContextForChain } = require('./luna-guest-context-merge');
const {
  detectPrivateLessonSessionCount,
  buildPrivateLessonSessionTimesReply,
  buildPrivateLessonReply,
} = require('./luna-guest-service-transfer-explainer');
const { executeSunsetCatalogTool } = require('./sunset-catalog-tool-executor');
const {
  matchRentalFromMessage,
  buildRentalAvailabilitySummary,
  listConfiguredRentalOfferings,
} = require('./sunset-rental-price-lookup');
const {
  isSunsetClientSlug,
  attachSunsetSchoolToGuestContext,
  loadSunsetSchoolContextFromConversation,
  resolveSunsetAdminConfigForLuna,
  buildSunsetSchoolPromptHint,
  slimSunsetSchoolContextForChain,
} = require('./sunset-luna-school-context');
const {
  ensureWaiverForBookingSoft,
  composeLunaWaiverReply,
  attachLunaWaiverFields,
  isLessonReadyForGuest,
  buildLunaWaiverInviteMessage,
  buildLunaWaiverCompletedMessage,
  buildLunaWaiverPendingReminderMessage,
} = require('./sunset-waiver-booking');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

const LESSON_TIMES_RE = /\b(?:lesson\s+times?|what\s+time\s+(?:are|is)\s+(?:the\s+)?(?:surf\s+)?lessons?|when\s+are\s+(?:the\s+)?(?:surf\s+)?lessons?|horario\s+(?:de\s+)?(?:clases|surf)|a\s+che\s+ora\s+(?:sono\s+)?(?:le\s+)?lezioni)\b/i;
const PRIVATE_LESSON_RE = /\b(?:private\s+lessons?|clases?\s+privadas?|lezioni\s+private|privat(?:kurs|stunde|unterricht)|cours\s+priv[eé])\b/i;
const PRICE_RE = /\b(?:how\s+much|price|cost|precio|prezzo|cuanto|cuesta|quanto\s+costa)\b/i;
const RENTAL_RE = /\b(?:rent|rental|hire|alquil|nolegg|miet)\b/i;
const AVAILABLE_RENTAL_RE = /\b(?:what(?:\'s| is)? available|what do you rent|what can i rent|rental (?:menu|options|list)|qu[eé] alquil|qu[eé] ten[eé]is|qu[eé] hay|material disponible|what gear)\b/i;

function detectLang(input, guestContext) {
  const hint = trimStr(input && input.language_hint).toLowerCase();
  if (hint && hint.length === 2) return hint;
  const prior = guestContext && guestContext.detected_language;
  if (prior) return prior;
  return 'en';
}

function formatLessonTimesReply(lang, schoolName, lessonTimes) {
  const times = Array.isArray(lessonTimes) ? lessonTimes.filter(Boolean) : [];
  if (!times.length) {
    if (lang === 'es') return `En ${schoolName} no tengo horarios de clase configurados todavía. ¿Qué día te interesa?`;
    return `At ${schoolName} I don't have lesson times configured yet. Which day works for you?`;
  }
  const list = times.map((t) => {
    if (typeof t === 'string') return t;
    if (t && t.time) return t.time;
    if (t && t.label) return t.label;
    return String(t);
  }).join(', ');
  if (lang === 'es') return `En ${schoolName}, las clases suelen ser: ${list}. ¿Qué día quieres reservar?`;
  return `At ${schoolName}, lesson times are: ${list}. Which day works for you?`;
}

function inferRentalLookup(messageText, adminCfg) {
  const matched = matchRentalFromMessage(messageText, adminCfg, { default_duration: null });
  return {
    item: matched.item || null,
    duration: matched.duration || null,
    ok: matched.ok === true,
    source: matched.source || null,
    offerings: matched.offerings || listConfiguredRentalOfferings(adminCfg),
  };
}

function formatPriceReply(lang, schoolName, lookup) {
  if (!lookup || lookup.ok !== true) {
    if (lang === 'es') return `En ${schoolName} no tengo ese precio confirmado todavía. ¿Qué alquiler y duración necesitas?`;
    return `At ${schoolName} I don't have a confirmed price for that yet. Which rental and duration do you need?`;
  }
  const amount = lookup.amount_eur != null ? lookup.amount_eur : lookup.amount_cents / 100;
  const cur = lookup.currency || 'EUR';
  if (lang === 'es') {
    return `En ${schoolName}, ${lookup.item} (${lookup.duration}): ${amount} ${cur}. ¿Te preparo la reserva?`;
  }
  return `At ${schoolName}, ${lookup.item} (${lookup.duration}): ${amount} ${cur}. Want me to help you book?`;
}

function buildDefaultReply(lang, schoolName) {
  if (lang === 'es') return `Hola, soy Luna de ${schoolName} 🌊 — ¿En qué te puedo ayudar hoy?`;
  return `Hi, I'm Luna from ${schoolName} 🌊 — how can I help you today?`;
}

function buildSunsetToolObservability(schoolContext, adminCfg, catalogResult) {
  return {
    sunset_school_context: slimSunsetSchoolContextForChain(schoolContext),
    sunset_admin_config_location_id: adminCfg && adminCfg.location_id,
    sunset_catalog_tool: catalogResult
      ? { tool_id: catalogResult.tool_id, ok: catalogResult.ok === true, reason: catalogResult.reason || null }
      : null,
  };
}

/**
 * Run one Sunset guest turn without Wolfhouse router/brain/availability chain.
 */
async function runSunsetGuestSchoolTurnDryRun(input, context, gate) {
  const inp = input || {};
  const ctx = context || {};
  const env = ctx.env || process.env;

  let chainGuestContext = normalizeGuestContextForChain(inp.guest_context);
  chainGuestContext = attachSunsetSchoolToGuestContext(chainGuestContext, {
    client_slug: 'sunset',
    conversation_metadata: inp.conversation_metadata,
    env,
  });

  if (ctx.pg && inp.conversation_id) {
    const loaded = await loadSunsetSchoolContextFromConversation(
      ctx.pg,
      'sunset',
      inp.conversation_id,
      env,
    );
    if (loaded) {
      chainGuestContext = attachSunsetSchoolToGuestContext(chainGuestContext, {
        client_slug: 'sunset',
        location_id: loaded.location_id,
        env,
      });
    }
  }

  const school = chainGuestContext.school_context;
  const schoolName = school.school_display_name;
  const locationId = school.location_id;
  const lang = detectLang(inp, chainGuestContext);
  const messageText = trimStr(inp.message_text);
  const adminCfg = resolveSunsetAdminConfigForLuna('sunset', locationId);

  let proposedReply = buildDefaultReply(lang, schoolName);
  let proposedNextAction = 'await_guest_reply';
  let catalogResult = null;
  const toolPayloads = [{
    kind: 'admin_config_lookup',
    client_slug: 'sunset',
    location_id: locationId,
  }];

  if (LESSON_TIMES_RE.test(messageText)) {
    proposedReply = formatLessonTimesReply(lang, schoolName, adminCfg && adminCfg.lesson_times);
    toolPayloads.push({ kind: 'lesson_times', location_id: locationId });
  } else if (PRIVATE_LESSON_RE.test(messageText)) {
    const plCatalog = executeSunsetCatalogTool('get_sunset_private_lesson', {
      client_slug: 'sunset',
      location_id: locationId,
      dry_run: true,
      args: {},
    });
    catalogResult = plCatalog;
    toolPayloads.push({ kind: 'get_sunset_private_lesson', location_id: locationId });
    const sessionCount = detectPrivateLessonSessionCount(messageText);
    const duration = plCatalog.ok && plCatalog.result
      ? plCatalog.result.default_duration_minutes
      : (adminCfg && adminCfg.private_lesson && adminCfg.private_lesson.default_duration_minutes);
    if (sessionCount != null) {
      proposedReply = buildPrivateLessonSessionTimesReply(lang, sessionCount, duration);
    } else {
      proposedReply = buildPrivateLessonReply(lang);
    }
  } else if (AVAILABLE_RENTAL_RE.test(messageText) || (RENTAL_RE.test(messageText) && /\b(?:available|options|menu|what)\b/i.test(messageText) && !PRICE_RE.test(messageText))) {
    proposedReply = buildRentalAvailabilitySummary(lang, schoolName, adminCfg);
    toolPayloads.push({
      kind: 'rental_catalog_menu',
      location_id: locationId,
      offerings: listConfiguredRentalOfferings(adminCfg).map((o) => o.offering_key),
    });
  } else if ((PRICE_RE.test(messageText) && RENTAL_RE.test(messageText)) || RENTAL_RE.test(messageText)) {
    const lookup = inferRentalLookup(messageText, adminCfg);
    if (!lookup.item) {
      proposedReply = buildRentalAvailabilitySummary(lang, schoolName, adminCfg);
      toolPayloads.push({
        kind: 'rental_catalog_menu',
        location_id: locationId,
        offerings: listConfiguredRentalOfferings(adminCfg).map((o) => o.offering_key),
      });
    } else if (!lookup.duration) {
      const off = (lookup.offerings || []).find((o) => o.offering_key === lookup.item);
      const durs = ((off && off.durations) || []).map((d) => d.replace(/_/g, ' ')).join(', ');
      if (lang === 'es') {
        proposedReply = durs
          ? `Para ${off && off.label ? off.label : lookup.item} tengo: ${durs}. ¿Qué duración quieres?`
          : `¿Para cuánto tiempo necesitas el alquiler?`;
      } else {
        proposedReply = durs
          ? `For ${off && off.label ? off.label : lookup.item} I have: ${durs}. Which duration do you need?`
          : `How long do you need the rental for?`;
      }
      toolPayloads.push({ kind: 'rental_duration_prompt', location_id: locationId, item: lookup.item });
    } else {
      catalogResult = executeSunsetCatalogTool('get_sunset_rental_price', {
        client_slug: 'sunset',
        location_id: locationId,
        dry_run: true,
        args: { item: lookup.item, duration: lookup.duration, require_confirmed: false },
      });
      toolPayloads.push({
        kind: 'get_sunset_rental_price',
        location_id: locationId,
        item: lookup.item,
        duration: lookup.duration,
      });
      proposedReply = formatPriceReply(lang, schoolName, catalogResult.result || catalogResult);
    }
  }

  // Waiver status / ensure (Sunset lesson booking). No outbound guest messaging.
  // - Pass waiver / waiver_status / public_url to compose copy without DB writes.
  // - Pass booking_id + confirm_write=true + pg to create/reuse a waiver request.
  let waiverBody = null;
  let lessonReady = null;
  if (inp.waiver && typeof inp.waiver === 'object') {
    waiverBody = attachLunaWaiverFields({
      success: true,
      waiver: inp.waiver,
      guest_count: inp.guest_count || inp.waiver.guest_count || 1,
      multi_student_note: inp.multi_student_note || null,
      waiver_status: inp.waiver.status,
    });
  } else if (inp.waiver_status || inp.waiver_public_url) {
    const guestCount = Number(inp.guest_count) || 1;
    const isGroup = guestCount > 1 || inp.expected_request_mode === 'group';
    waiverBody = attachLunaWaiverFields({
      success: true,
      guest_count: guestCount,
      expected_request_mode: isGroup ? 'group' : 'single',
      target_count: inp.target_count != null ? inp.target_count : (isGroup ? guestCount : null),
      completed_count: inp.completed_count != null ? inp.completed_count : 0,
      waiver_status: inp.waiver_status || 'pending',
      waiver: {
        status: inp.waiver_status || 'pending',
        public_url: inp.waiver_public_url || null,
        request_mode: isGroup ? 'group' : 'single',
        target_count: inp.target_count != null ? inp.target_count : (isGroup ? guestCount : null),
        completed_count: inp.completed_count != null ? inp.completed_count : 0,
      },
    });
  } else if (
    inp.booking_id
    && ctx.pg
    && (inp.confirm_write === true || inp.ensure_waiver === true)
  ) {
    const ensured = await ensureWaiverForBookingSoft(ctx.pg, inp.booking_id, {
      locationId,
      env,
      source: inp.waiver_source || 'luna_guest_turn',
    });
    if (ensured && ensured.ok && ensured.body) {
      waiverBody = ensured.body;
    }
  }

  if (waiverBody) {
    const mode = trimStr(inp.waiver_reply_mode) || (
      String(waiverBody.waiver_lane || '') === 'pending' && inp.waiver_reminder === true
        ? 'reminder'
        : 'invite'
    );
    proposedReply = composeLunaWaiverReply(waiverBody, mode);
    proposedNextAction = waiverBody.lesson_ready === true
      ? 'waiver_completed'
      : 'send_waiver_link';
    lessonReady = waiverBody.lesson_ready === true;
  }

  const result = {
    success: true,
    message_lane: 'sunset_inquiry',
    intake_state: 'inquiry_received',
    readiness_state: 'collecting_required_details',
    booking_intake_ready: false,
    detected_language: lang,
    extracted_fields: {},
    proposed_luna_reply: proposedReply,
    sunset_school_prompt_hint: buildSunsetSchoolPromptHint(school),
    sunset_tool_payloads: toolPayloads,
    safe_handoff_required: false,
    handoff_reasons: [],
    waiver: waiverBody ? (waiverBody.waiver || null) : null,
    waiver_lane: waiverBody ? waiverBody.waiver_lane : null,
    luna_waiver_message: waiverBody ? waiverBody.luna_waiver_message : null,
    lesson_ready: lessonReady,
    lesson_ready_blocked_reason: (lessonReady === false)
      ? 'waiver_not_completed'
      : null,
  };

  return {
    automation_gate: gate,
    result,
    availability: null,
    quote: null,
    payment_choice: null,
    hold_payment_draft_plan: null,
    guest_context_chain: {
      ...chainGuestContext,
      location_id: locationId,
      school_context: school,
      client_slug: 'sunset',
    },
    proposed_next_action: proposedNextAction,
    proposed_luna_reply: proposedReply,
    sunset_observability: buildSunsetToolObservability(school, adminCfg, catalogResult),
  };
}

module.exports = {
  runSunsetGuestSchoolTurnDryRun,
  inferRentalLookup,
  buildRentalAvailabilitySummary,
  isSunsetClientSlug,
  buildLunaWaiverInviteMessage,
  buildLunaWaiverCompletedMessage,
  buildLunaWaiverPendingReminderMessage,
  composeLunaWaiverReply,
  isLessonReadyForGuest,
};
