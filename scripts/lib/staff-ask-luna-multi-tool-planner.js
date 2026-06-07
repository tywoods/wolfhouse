/**
 * Phase 11h — Staff Ask Luna read-only multi-tool ops planner.
 *
 * Selects existing read-only Phase 11 intents, executes them, combines answers.
 * AI planner is optional (STAFF_ASK_LUNA_AI_ENABLED); deterministic defaults when AI off.
 *
 * @module staff-ask-luna-multi-tool-planner
 */

'use strict';

const {
  isAskLunaAiEnabled,
  getConfidenceMin,
  SQL_OR_TOOL_RE,
  extractJsonObjectText,
} = require('./staff-ask-luna-ai-intent');
const { getAskLunaLessonsOnDateQuery, formatAskLunaLessonsAnswer } = require('./staff-ask-luna-lessons');
const { getAskLunaGearOnDateQuery, formatAskLunaGearAnswer } = require('./staff-ask-luna-gear');
const { getAskLunaMealsOnDateQuery, getAskLunaYogaOnDateQuery, formatAskLunaMealsYogaAnswer } = require('./staff-ask-luna-meals-yoga');
const {
  getAskLunaArrivalsOnDateQuery,
  getAskLunaCheckoutsOnDateQuery,
  formatAskLunaArrivalsCheckoutsAnswer,
} = require('./staff-ask-luna-arrivals-checkouts');
const {
  getAskLunaCleaningOnDateQuery,
  formatAskLunaCleaningAnswer,
  buildCleaningGroups,
} = require('./staff-ask-luna-cleaning');
const { computeBalanceDueRows, formatAskLunaBalanceDueAnswer } = require('./staff-ask-luna-balance-due');
const { callLunaAiJsonChat } = require('./luna-ai-provider');

const OPS_MULTI_TOOL_INTENT = 'ops.multi_tool_summary';
const MAX_PLANNER_TOOLS = 8;

const OPS_PLANNER_TOOL_ALLOWLIST = new Set([
  'payments.balance_due',
  'services.lessons_today',
  'services.lessons_tomorrow',
  'services.gear_today',
  'services.gear_tomorrow',
  'services.meals_today',
  'services.meals_tomorrow',
  'services.yoga_today',
  'services.yoga_tomorrow',
  'bookings.arrivals_today',
  'bookings.arrivals_tomorrow',
  'bookings.checkouts_today',
  'bookings.checkouts_tomorrow',
  'housekeeping.cleaning_today',
  'housekeeping.cleaning_tomorrow',
]);

const WEEKDAY_WORDS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;

function askLunaIsoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function askLunaTodayUTC(refDate = new Date()) {
  return askLunaIsoDateUTC(refDate);
}

function askLunaTomorrowUTC(refDate = new Date()) {
  const d = new Date(refDate);
  d.setUTCDate(d.getUTCDate() + 1);
  return askLunaIsoDateUTC(d);
}

function normalizeOpsPlannerQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function askLunaHasTodayWord(q) {
  return /\b(today|tonight|hoy|oggi|heute)\b/.test(q);
}

function askLunaHasTomorrowWord(q) {
  return /\b(tomorrow|manana|domani|morgen|demain)\b/.test(q);
}

function matchesOpsPlannerTopic(q) {
  if (/\b(ops\s+summary|operations\s+summary|daily\s+ops|ops\s+brief)\b/.test(q)) {
    return true;
  }
  if (/\b(prepare|prep|need\s+to\s+know|what\s+do\s+i\s+need)\b/.test(q)
    && (askLunaHasTodayWord(q) || askLunaHasTomorrowWord(q))) {
    return true;
  }
  if (/\bwhat\s+(?:s\s+|is\s+)?(happening|going\s+on)\b/.test(q)
    && (askLunaHasTodayWord(q) || askLunaHasTomorrowWord(q))) {
    return true;
  }
  if (/\b(show|give\s+me)\b/.test(q) && /\boperations\b/.test(q)
    && (askLunaHasTodayWord(q) || askLunaHasTomorrowWord(q))) {
    return true;
  }
  if (/\b(today|tomorrow)\s+s?\s+operations\b/.test(q)) {
    return true;
  }
  if (/\b(any\s+)?important\s+stuff\b.*\btoday\b/.test(q)) {
    return true;
  }
  return false;
}

/**
 * @returns {{ when: 'today'|'tomorrow', date: string, dateLabel: string } | { rejected: true, intentHint: string } | null}
 */
function detectOpsPlannerRequest(question, refDate = new Date()) {
  const q = normalizeOpsPlannerQuestionText(question);
  const hasToday = askLunaHasTodayWord(q);
  const hasTomorrow = askLunaHasTomorrowWord(q);
  const hasWeekday = WEEKDAY_WORDS.test(q);

  if (hasWeekday && !hasToday && !hasTomorrow
    && /\b(ops|operations|summary|prepare|need\s+to\s+know|happening|going\s+on|important)\b/.test(q)) {
    return {
      rejected: true,
      intentHint: 'Ops summaries support today or tomorrow only. Ask for today\'s or tomorrow\'s ops summary.',
    };
  }

  if (!matchesOpsPlannerTopic(q)) return null;

  if (hasWeekday && !hasToday && !hasTomorrow) {
    return {
      rejected: true,
      intentHint: 'Ops summaries support today or tomorrow only. Ask for today\'s or tomorrow\'s ops summary.',
    };
  }

  const when = hasTomorrow && !hasToday ? 'tomorrow' : 'today';
  const date = when === 'tomorrow' ? askLunaTomorrowUTC(refDate) : askLunaTodayUTC(refDate);
  return { when, date, dateLabel: when };
}

/**
 * @param {'today'|'tomorrow'} when
 * @returns {string[]}
 */
function getDefaultOpsToolIntents(when) {
  const suffix = when === 'tomorrow' ? 'tomorrow' : 'today';
  return [
    `bookings.arrivals_${suffix}`,
    `bookings.checkouts_${suffix}`,
    `housekeeping.cleaning_${suffix}`,
    `services.lessons_${suffix}`,
    `services.gear_${suffix}`,
    `services.meals_${suffix}`,
    `services.yoga_${suffix}`,
    'payments.balance_due',
  ];
}

function buildPlannerSystemPrompt(allowedList, when) {
  const lines = allowedList.map((k) => `- ${k}`);
  return [
    'Select read-only staff ops tool intents for a broad operations summary.',
    `Focus window: ${when} (use only *_${when} intents plus payments.balance_due when relevant).`,
    'Return JSON only with keys: tool_intents (string array), confidence (0-1), reason (short string).',
    'Do not answer the question. Do not generate SQL. Do not call tools. Max 8 intents.',
    '',
    'Allowed tool_intents:',
    ...lines,
  ].join('\n');
}

/**
 * @param {string} rawText
 * @param {Set<string>} allowed
 * @param {{ minConfidence?: number }} [opts]
 * @returns {{ tool_intents: string[], confidence: number, reason: string } | null}
 */
function parseAndValidatePlannerOutput(rawText, allowed, opts = {}) {
  const minConfidence = opts.minConfidence != null ? opts.minConfidence : getConfidenceMin();
  const raw = String(rawText || '').trim();
  if (!raw || SQL_OR_TOOL_RE.test(raw)) return null;

  const jsonText = extractJsonObjectText(raw);
  if (!jsonText || SQL_OR_TOOL_RE.test(jsonText)) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_) {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const intentsRaw = parsed.tool_intents;
  if (!Array.isArray(intentsRaw) || intentsRaw.length === 0) return null;
  if (intentsRaw.length > MAX_PLANNER_TOOLS) return null;

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) return null;

  const reason = parsed.reason != null ? String(parsed.reason) : '';
  if (SQL_OR_TOOL_RE.test(reason)) return null;

  const toolIntents = [];
  for (const item of intentsRaw) {
    if (typeof item !== 'string') return null;
    const key = item.trim();
    if (!allowed.has(key) || SQL_OR_TOOL_RE.test(key)) return null;
    if (!toolIntents.includes(key)) toolIntents.push(key);
  }
  if (toolIntents.length === 0) return null;

  return {
    tool_intents: toolIntents,
    confidence: Math.min(1, Math.max(0, confidence)),
    reason: reason.slice(0, 300),
  };
}

async function defaultPlannerProvider(question, allowedList, when) {
  const system = buildPlannerSystemPrompt(allowedList, when);
  const content = await callLunaAiJsonChat({
    env: process.env,
    system,
    user: String(question || ''),
    maxTokens: 512,
    temperature: 0,
    jsonObject: true,
  });
  if (content == null) return null;
  return content;
}

/**
 * @param {string} question
 * @param {{ when: string, provider?: Function, minConfidence?: number }} opts
 */
async function classifyOpsPlannerWithAi(question, opts = {}) {
  if (!isAskLunaAiEnabled()) return null;

  const when = opts.when === 'tomorrow' ? 'tomorrow' : 'today';
  const allowedList = [...OPS_PLANNER_TOOL_ALLOWLIST];
  const allowedSet = new Set(allowedList);

  const provider = opts.provider || defaultPlannerProvider;
  let rawText;
  try {
    rawText = await provider(question, allowedList, when);
  } catch (err) {
    console.warn('[ask-luna-planner] provider error:', err.message);
    return null;
  }

  if (rawText == null || rawText === '') return null;

  return parseAndValidatePlannerOutput(rawText, allowedSet, {
    minConfidence: opts.minConfidence,
  });
}

function plannerSqlForIntent(intentKey) {
  const map = {
    'services.lessons_today': getAskLunaLessonsOnDateQuery,
    'services.lessons_tomorrow': getAskLunaLessonsOnDateQuery,
    'services.gear_today': getAskLunaGearOnDateQuery,
    'services.gear_tomorrow': getAskLunaGearOnDateQuery,
    'services.meals_today': getAskLunaMealsOnDateQuery,
    'services.meals_tomorrow': getAskLunaMealsOnDateQuery,
    'services.yoga_today': getAskLunaYogaOnDateQuery,
    'services.yoga_tomorrow': getAskLunaYogaOnDateQuery,
    'bookings.arrivals_today': getAskLunaArrivalsOnDateQuery,
    'bookings.arrivals_tomorrow': getAskLunaArrivalsOnDateQuery,
    'bookings.checkouts_today': getAskLunaCheckoutsOnDateQuery,
    'bookings.checkouts_tomorrow': getAskLunaCheckoutsOnDateQuery,
    'housekeeping.cleaning_today': getAskLunaCleaningOnDateQuery,
    'housekeeping.cleaning_tomorrow': getAskLunaCleaningOnDateQuery,
  };
  return map[intentKey] || null;
}

/**
 * Run one planner tool (read-only).
 * @returns {Promise<{ ok: boolean, intentKey: string, rows?: object[], error?: string }>}
 */
async function runOpsPlannerTool(pgClient, clientSlug, intentKey, date, dateLabel) {
  try {
    if (intentKey === 'payments.balance_due') {
      const rows = await computeBalanceDueRows(pgClient, clientSlug);
      return { ok: true, intentKey, rows };
    }
    const sqlFn = plannerSqlForIntent(intentKey);
    if (!sqlFn) {
      return { ok: false, intentKey, error: 'unsupported tool' };
    }
    const result = await pgClient.query(sqlFn(), [clientSlug, date]);
    return { ok: true, intentKey, rows: result.rows };
  } catch (err) {
    return { ok: false, intentKey, error: err.message };
  }
}

function fmtCtxForTool(intentKey, date, dateLabel) {
  const ctx = { date, dateLabel };
  if (intentKey.includes('arrivals')) ctx.flow = 'arrivals';
  if (intentKey.includes('checkout')) ctx.flow = 'checkouts';
  if (intentKey.includes('meals')) ctx.serviceCategory = 'meals';
  if (intentKey.includes('yoga')) ctx.serviceCategory = 'yoga';
  return ctx;
}

function summarizeArrivalsCheckouts(intentKey, rows, ctx) {
  const flow = intentKey.includes('checkout') ? 'checkouts' : 'arrivals';
  const label = flow === 'checkouts' ? 'Checkouts' : 'Arrivals';
  const list = rows || [];
  if (list.length === 0) {
    return { heading: `${label}: none scheduled.`, bullets: [] };
  }
  const bullets = list.slice(0, 3).map((r) => {
    const name = r.guest_name || r.booking_code || 'Guest';
    const bed = r.bed_summary ? ` — ${r.bed_summary}` : '';
    const guests = Number(r.guest_count) > 0 ? ` — ${r.guest_count} guest${r.guest_count !== 1 ? 's' : ''}` : '';
    return `* ${name} — ${r.booking_code}${bed}${guests}.`;
  });
  return {
    heading: `${label}: ${list.length} guest${list.length !== 1 ? 's' : ''}/booking${list.length !== 1 ? 's' : ''}.`,
    bullets,
  };
}

function summarizeCleaning(rows, ctx) {
  const groups = buildCleaningGroups(rows);
  if (groups.bookingCount === 0) {
    return { heading: 'Checkouts / cleaning: no turnover flagged.', bullets: [] };
  }
  const bullets = [];
  for (const room of groups.rooms.slice(0, 2)) {
    for (const b of room.bedLines.slice(0, 2)) {
      bullets.push(`* ${room.room_code} — ${b.bed_label} — ${b.guest_name} — ${b.booking_code}.`);
    }
  }
  const bedPart = groups.bedCount > 0 ? `, ${groups.bedCount} bed${groups.bedCount !== 1 ? 's' : ''} likely needing turnover` : '';
  return {
    heading: `Checkouts / cleaning: ${groups.bookingCount} checkout${groups.bookingCount !== 1 ? 's' : ''}${bedPart}.`,
    bullets: bullets.slice(0, 3),
  };
}

function summarizeLessons(rows, ctx) {
  const text = formatAskLunaLessonsAnswer(rows, ctx);
  const m = text.match(/there are (\d+) surf lesson/i);
  const count = m ? m[1] : String((rows || []).length);
  if (Number(count) === 0 || text.includes('No surf lessons')) {
    return { heading: 'Lessons: no lessons booked.', bullets: [] };
  }
  return { heading: `Lessons: ${count} lesson${count !== '1' ? 's' : ''} booked.`, bullets: [] };
}

function summarizeGear(rows, ctx) {
  const text = formatAskLunaGearAnswer(rows, ctx);
  if (text.includes('No surf gear')) {
    return { heading: 'Gear: none booked.', bullets: [] };
  }
  const boards = (rows || []).filter((r) => String(r.service_type).includes('surfboard')).length;
  const wetsuits = (rows || []).filter((r) => String(r.service_type).includes('wetsuit')).length;
  const parts = [];
  if (boards) parts.push(`${boards} board${boards !== 1 ? 's' : ''}`);
  if (wetsuits) parts.push(`${wetsuits} wetsuit${wetsuits !== 1 ? 's' : ''}`);
  return {
    heading: `Gear: ${parts.length ? parts.join(', ') + ' needed.' : 'gear booked.'}`,
    bullets: [],
  };
}

function summarizeMealsYoga(intentKey, rows, ctx) {
  const category = intentKey.includes('yoga') ? 'yoga' : 'meals';
  const text = formatAskLunaMealsYogaAnswer(rows, { ...ctx, serviceCategory: category });
  const label = category === 'yoga' ? 'Yoga' : 'Meals';
  if (text.includes('No ') && text.includes('booked')) {
    return { heading: `${label}: none booked.`, bullets: [] };
  }
  const m = text.match(/(\d+)\s+(?:meal|yoga|class)/i);
  const count = m ? m[1] : String((rows || []).length);
  return {
    heading: `${label}: ${count} ${category === 'yoga' ? 'class' : 'meal'}${count !== '1' ? 's' : ''} booked.`,
    bullets: [],
  };
}

function summarizeBalanceDue(rows) {
  if (!rows || rows.length === 0) {
    return { heading: 'Payments: no outstanding balances.', bullets: [] };
  }
  const totalCents = rows.reduce((s, r) => s + Number(r.balance_due_cents || 0), 0);
  const euro = `€${(Math.round(totalCents) / 100).toFixed(0)}`;
  return {
    heading: `Payments: ${rows.length} active booking${rows.length !== 1 ? 's' : ''} still have balance due, total outstanding ${euro}.`,
    bullets: [],
  };
}

/**
 * @param {{ ok: boolean, intentKey: string, rows?: object[], error?: string }} toolResult
 * @param {{ date: string, dateLabel: string }} ctx
 */
function summarizePlannerToolResult(toolResult, ctx) {
  const { intentKey, ok, rows, error } = toolResult;
  if (!ok) {
    const label = intentKey.replace(/\./g, ' ');
    return { heading: `${label}: unavailable right now.`, bullets: [], failed: true };
  }
  const fmt = fmtCtxForTool(intentKey, ctx.date, ctx.dateLabel);

  if (intentKey === 'payments.balance_due') return summarizeBalanceDue(rows);
  if (intentKey.includes('arrivals') || intentKey.includes('checkouts')) {
    return summarizeArrivalsCheckouts(intentKey, rows, fmt);
  }
  if (intentKey.includes('cleaning')) return summarizeCleaning(rows, fmt);
  if (intentKey.includes('lessons')) return summarizeLessons(rows, fmt);
  if (intentKey.includes('gear')) return summarizeGear(rows, fmt);
  if (intentKey.includes('meals') || intentKey.includes('yoga')) {
    return summarizeMealsYoga(intentKey, rows, fmt);
  }
  return { heading: `${intentKey}: ${(rows || []).length} result(s).`, bullets: [] };
}

/**
 * @param {Array<{ heading: string, bullets: string[], failed?: boolean }>} sections
 * @param {string} dateLabel
 */
function formatCombinedOpsPlannerAnswer(sections, dateLabel = 'today') {
  const when = dateLabel === 'tomorrow' ? 'tomorrow' : 'today';
  const lines = [`Here's ${when}'s ops summary:`, ''];

  for (const sec of sections) {
    lines.push(sec.heading);
    if (sec.bullets && sec.bullets.length) {
      lines.push('');
      for (const b of sec.bullets) lines.push(b);
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n\n\n+/g, '\n\n').trim();
}

/**
 * @param {import('pg').Client} pgClient
 * @param {string} clientSlug
 * @param {string[]} toolIntents
 * @param {{ date: string, dateLabel: string }} ctx
 */
async function executeOpsPlannerTools(pgClient, clientSlug, toolIntents, ctx) {
  const sections = [];
  const allRows = [];

  for (const intentKey of toolIntents) {
    if (!OPS_PLANNER_TOOL_ALLOWLIST.has(intentKey)) continue;
    const result = await runOpsPlannerTool(
      pgClient,
      clientSlug,
      intentKey,
      ctx.date,
      ctx.dateLabel,
    );
    if (result.ok && result.rows) allRows.push(...result.rows);
    sections.push(summarizePlannerToolResult(result, ctx));
  }

  return { sections, allRows };
}

/**
 * Resolve ops planner when broad ops question detected.
 * @returns {Promise<object|null>}
 */
async function resolveOpsPlannerIntent(question, refDate = new Date()) {
  const detected = detectOpsPlannerRequest(question, refDate);
  if (!detected) return null;
  if (detected.rejected) {
    return {
      intentKey: 'unsupported_intent',
      intentHint: detected.intentHint,
      intent_source: 'ops_planner',
    };
  }

  let toolIntents = getDefaultOpsToolIntents(detected.when);
  let confidence = 1;
  let reason = `Deterministic ${detected.when} ops summary.`;
  let intent_source = 'ops_planner_deterministic';

  if (isAskLunaAiEnabled()) {
    const ai = await classifyOpsPlannerWithAi(question, { when: detected.when });
    if (ai && ai.tool_intents && ai.tool_intents.length) {
      toolIntents = ai.tool_intents;
      confidence = ai.confidence;
      reason = ai.reason;
      intent_source = 'ops_planner_ai';
    }
  }

  return {
    intentKey: OPS_MULTI_TOOL_INTENT,
    extraParams: {
      date: detected.date,
      dateLabel: detected.dateLabel,
      tool_intents: toolIntents,
    },
    intent_source,
    ai_confidence: confidence,
    ai_reason: reason,
  };
}

module.exports = {
  OPS_MULTI_TOOL_INTENT,
  OPS_PLANNER_TOOL_ALLOWLIST,
  MAX_PLANNER_TOOLS,
  detectOpsPlannerRequest,
  matchesOpsPlannerTopic,
  getDefaultOpsToolIntents,
  parseAndValidatePlannerOutput,
  classifyOpsPlannerWithAi,
  runOpsPlannerTool,
  executeOpsPlannerTools,
  summarizePlannerToolResult,
  formatCombinedOpsPlannerAnswer,
  resolveOpsPlannerIntent,
};
