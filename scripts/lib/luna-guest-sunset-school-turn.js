'use strict';

/**
 * Sunset guest automation turn (dry-run) — school-aware, isolated from Wolfhouse chain.
 * No outbound WhatsApp/email, no writes, no Stripe sends.
 */

const { normalizeGuestContextForChain } = require('./luna-guest-context-merge');
const { executeSunsetCatalogTool } = require('./sunset-catalog-tool-executor');
const {
  isSunsetClientSlug,
  attachSunsetSchoolToGuestContext,
  loadSunsetSchoolContextFromConversation,
  resolveSunsetAdminConfigForLuna,
  buildSunsetSchoolPromptHint,
  slimSunsetSchoolContextForChain,
} = require('./sunset-luna-school-context');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

const LESSON_TIMES_RE = /\b(?:lesson\s+times?|what\s+time\s+(?:are|is)\s+(?:the\s+)?(?:surf\s+)?lessons?|when\s+are\s+(?:the\s+)?(?:surf\s+)?lessons?|horario\s+(?:de\s+)?(?:clases|surf)|a\s+che\s+ora\s+(?:sono\s+)?(?:le\s+)?lezioni)\b/i;
const PRICE_RE = /\b(?:how\s+much|price|cost|precio|prezzo|cuanto|cuesta|quanto\s+costa)\b/i;
const RENTAL_RE = /\b(?:rent|rental|hire|alquil|nolegg|miet)\b/i;

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

function inferRentalLookup(messageText) {
  const t = trimStr(messageText).toLowerCase();
  let item = 'board_rental';
  let duration = '1_day';
  if (/\bwetsuit\b|\bneopren\b|\bmuta\b/.test(t)) item = 'wetsuit_rental';
  if (/\bboard\s+and\s+suit\b|\bboard\s*&\s*suit\b|\bbundle\b/.test(t)) item = 'board_and_suit_rental';
  if (/\b1\s*h(?:our)?\b|\buna\s+hora\b/.test(t)) duration = '1_hour';
  if (/\bhalf\s*day\b|\bmedio\s+d[ií]a\b/.test(t)) duration = 'half_day';
  if (/\b2\s*days?\b|\bdos\s+d[ií]as\b/.test(t)) duration = '2_days';
  if (/\b5\s*days?\b/.test(t)) duration = '5_days';
  if (/\b7\s*days?\b|\bweek\b|\bsemana\b/.test(t)) duration = '7_days';
  return { item, duration };
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
  } else if (PRICE_RE.test(messageText) && RENTAL_RE.test(messageText)) {
    const { item, duration } = inferRentalLookup(messageText);
    catalogResult = executeSunsetCatalogTool('get_sunset_rental_price', {
      client_slug: 'sunset',
      location_id: locationId,
      dry_run: true,
      args: { item, duration, require_confirmed: false },
    });
    toolPayloads.push({
      kind: 'get_sunset_rental_price',
      location_id: locationId,
      item,
      duration,
    });
    proposedReply = formatPriceReply(lang, schoolName, catalogResult.result || catalogResult);
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
  isSunsetClientSlug,
};
