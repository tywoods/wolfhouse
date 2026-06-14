'use strict';

/**
 * Stage 56 Milestone B — Unified frontdesk planner (transcript + tools + reply plan).
 *
 * Pre-chain: GPT plans read tools with full thread context; executes allowlisted reads.
 * Post-chain: deterministic reply plan from chain truth + missing fields for Cami voice.
 */

const { callLunaAiJsonChat } = require('./luna-ai-provider');
const {
  GUEST_AGENT_READ_TOOL_IDS,
  isGuestAgentWriteTool,
} = require('./luna-guest-agent-tool-plan');
const { executeGuestAgentReadTool } = require('./luna-guest-agent-tool-executor');
const { applyPlannerFieldSeed } = require('./luna-guest-gpt-tool-planner');

function fieldPatchFromResults(toolResults) {
  const collect = (toolResults || []).find((t) => t.tool_id === 'collect_missing_booking_fields' && t.status === 'ok');
  if (!collect || !collect.result) return null;
  const merged = collect.result.merged_extracted_fields;
  if (!merged || !Object.keys(merged).length) return null;
  return merged;
}
const { collectPriorExtractedFields } = require('./luna-guest-context-merge');
const { resolveActiveThread } = require('./luna-guest-thread-state');
const { buildBookingIntakePolicySnapshot } = require('./luna-booking-intake-policy');

const FLAG = 'LUNA_GUEST_FRONTDESK_PLANNER_ENABLED';
const FLAG_PROD = 'LUNA_GUEST_FRONTDESK_PLANNER_ENABLED_PROD';
const ACTIVE_FLAG = 'LUNA_GUEST_FRONTDESK_PLANNER_ACTIVE';
const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_PLANNED_TOOLS = 6;

const ASK_COMPOSER_STATES = new Set([
  'ask_dates', 'confirm_dates', 'ask_guests', 'ask_guest_name', 'ask_package',
  'ask_room_preference_girls_mixed', 'ask_room_preference_private_shared',
  'ask_room_preference_neutral', 'ask_transfer_info_casual', 'ask_package_choice',
  'ask_addons_after_quote', 'ask_payment_choice', 'clarify_missing_info',
  'package_quote_ready', 'accommodation_quote_ready', 'addons_none_confirmed',
  'greeting',
]);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isProductionEnv(env) {
  return String((env || {}).NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isGuestFrontdeskPlannerEnabled(env) {
  const e = env || process.env;
  if (isProductionEnv(e)) return String(e[FLAG_PROD] || '').toLowerCase() === 'true';
  return String(e[FLAG] || '').toLowerCase() === 'true';
}

function isGuestFrontdeskPlannerActive(env) {
  return isGuestFrontdeskPlannerEnabled(env)
    && String((env || process.env)[ACTIVE_FLAG] || '').toLowerCase() === 'true';
}

function frontdeskModel(env) {
  return trimStr((env || process.env).LUNA_GUEST_FRONTDESK_PLANNER_MODEL) || DEFAULT_MODEL;
}

function frontdeskTimeoutMs(env) {
  const v = Number((env || process.env).LUNA_GUEST_FRONTDESK_PLANNER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 45000) : DEFAULT_TIMEOUT_MS;
}

function buildFrontdeskSystemPrompt() {
  const readList = GUEST_AGENT_READ_TOOL_IDS.join(', ');
  return [
    'You are Luna frontdesk planner — one brain turn for Wolfhouse WhatsApp guest chat.',
    'You see the real conversation transcript and prior booking facts.',
    'Plan READ tools only for this turn. Never plan write tools.',
    `Allowed read tools: ${readList}`,
    'Rules (docs/LUNA-GUEST-BEHAVIOR-SPEC.md):',
    '- Use get_conversation_context when transcript shows an active booking flow.',
    '- Use collect_missing_booking_fields when guest provides dates, guests, package, or corrections.',
    '- Use explain_packages when guest asks about Malibu/Uluwatu/Waimea OR after dates+count before package choice.',
    '- NEVER ask "Malibu or accommodation?" before explaining all three tiers with WhatsApp spacing.',
    '- After package+dates+count known, plan tools toward quote/payment — never stall with "look into availability".',
    '- Capture service/transfer intent (board, wetsuit, yoga, airport pickup) when guest mentions them.',
    '- Use check_payment_status when guest says they paid or asks payment status.',
    '- Greeting only: warm welcome — no unsolicited package prices.',
    '- Do NOT re-welcome mid-thread (turn_index > 0).',
    '- Never hand off on vague/uncertain messages alone.',
    'Return ONLY JSON:',
    '{"planned_tools":["tool_id",...],"intent":"booking_intake|side_question|payment_question|greeting|post_booking_service|general","missing_fields":["dates","guest_count",...],"rationale":"short"}',
    'Max 6 tools.',
  ].join('\n');
}

function buildFrontdeskUserPrompt(input) {
  const prior = input.prior_guest_context || {};
  return JSON.stringify({
    latest_guest_message: input.message_text,
    active_thread: prior.active_thread || resolveActiveThread(prior),
    turn_index: Array.isArray(input.transcript) ? input.transcript.length : 0,
    transcript: (input.transcript || []).slice(-12).map((t) => ({
      role: t.role,
      text: (t.text || '').slice(0, 400),
    })),
    prior_extracted_fields: collectPriorExtractedFields(prior),
    prior_intake_state: (prior.result && prior.result.intake_state) || null,
    quote_status: (prior.quote && prior.quote.quote_status) || 'not_ready',
    booking_code: prior.booking_code || null,
    payment_link_sent: prior.payment_link_sent === true,
    allowed_read_tools: GUEST_AGENT_READ_TOOL_IDS,
  }, null, 2);
}

function parseFrontdeskJson(text) {
  const raw = trimStr(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.planned_tools)) return parsed;
  } catch (_) { /* fall through */ }
  const m = raw.match(/\{[\s\S]*"planned_tools"\s*:\s*\[[^\]]*\]/);
  if (m) {
    try {
      const parsed = JSON.parse(`${m[0]}}`);
      if (parsed && Array.isArray(parsed.planned_tools)) return parsed;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function sanitizePlannedTools(planned) {
  const out = [];
  const rejected = [];
  for (const t of planned || []) {
    const id = trimStr(t);
    if (!id) continue;
    if (isGuestAgentWriteTool(id)) {
      rejected.push({ tool_id: id, reason: 'write_tool_forbidden' });
      continue;
    }
    if (!GUEST_AGENT_READ_TOOL_IDS.includes(id)) {
      rejected.push({ tool_id: id, reason: 'unknown_tool' });
      continue;
    }
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_PLANNED_TOOLS) break;
  }
  return { planned_tools: out, rejected_tools: rejected };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('frontdesk_planner_timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function defaultFrontdeskCaller({ system, user, model, env }) {
  return callLunaAiJsonChat({
    system,
    user,
    env: { ...env, LUNA_AI_MODEL: model },
    maxTokens: 400,
    temperature: 0,
    jsonObject: true,
    call_label: 'luna_guest_frontdesk_planner',
  });
}

/**
 * Pre-chain: transcript-aware tool planner (replaces GPT tool planner when active).
 */
async function runGuestFrontdeskPlannerPreChain(input, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const inp = input || {};
  const base = {
    planner_enabled: isGuestFrontdeskPlannerEnabled(env),
    planner_active: isGuestFrontdeskPlannerActive(env),
    planner_used: false,
    fallback_used: true,
    planned_tools: [],
    rejected_tools: [],
    tool_results: [],
    field_patch: null,
    intent: null,
    missing_fields: [],
    planner_rationale: null,
    rejection_reason: null,
    safety_notes: [],
    transcript_source: inp.transcript_source || null,
    transcript_turns: Array.isArray(inp.transcript) ? inp.transcript.length : 0,
  };

  if (!base.planner_enabled) {
    base.rejection_reason = 'frontdesk_planner_disabled';
    return base;
  }

  const caller = opts.plannerCaller || defaultFrontdeskCaller;
  let rawPlan = null;
  try {
    rawPlan = await withTimeout(
      caller({
        system: buildFrontdeskSystemPrompt(),
        user: buildFrontdeskUserPrompt(inp),
        model: frontdeskModel(env),
        env,
      }),
      frontdeskTimeoutMs(env),
    );
  } catch (err) {
    base.rejection_reason = String((err && err.message) || err).slice(0, 120);
    base.safety_notes.push('planner_call_failed');
    return base;
  }

  const parsed = parseFrontdeskJson(rawPlan);
  if (!parsed) {
    base.rejection_reason = 'unparseable_plan';
    base.safety_notes.push('parse_failed');
    return base;
  }

  const sanitized = sanitizePlannedTools(parsed.planned_tools);
  base.planned_tools = sanitized.planned_tools;
  base.rejected_tools = sanitized.rejected_tools;
  base.planner_rationale = trimStr(parsed.rationale) || null;
  base.intent = trimStr(parsed.intent) || null;
  base.missing_fields = Array.isArray(parsed.missing_fields)
    ? parsed.missing_fields.map((f) => trimStr(f)).filter(Boolean)
    : [];

  if (!base.planned_tools.length) {
    base.rejection_reason = 'empty_plan';
    return base;
  }

  base.planner_used = true;
  base.fallback_used = false;

  const execCtx = {
    client_slug: inp.client_slug,
    message_text: inp.message_text,
    prior_guest_context: inp.prior_guest_context,
    reference_date: inp.reference_date,
    language: inp.language,
    contact_name: inp.contact_name,
    guest_phone: inp.guest_phone,
    env,
    chain_snapshot: opts.chain_snapshot || null,
    transcript: inp.transcript || [],
  };

  const results = [];
  for (const toolId of base.planned_tools) {
    results.push(executeGuestAgentReadTool(toolId, execCtx));
  }
  base.tool_results = results;
  base.field_patch = fieldPatchFromResults(results);

  return base;
}

function computePolicyMissing(payload, priorGuestContext) {
  const result = (payload && payload.result) || {};
  const policy = buildBookingIntakePolicySnapshot(
    {
      extracted_fields: result.extracted_fields || collectPriorExtractedFields(priorGuestContext),
      package_night_rule: result.package_night_rule,
    },
    {
      channel_guest_name: priorGuestContext && (priorGuestContext.contact_name || priorGuestContext.guest_name),
      quote: payload && payload.quote,
      payment_choice: payload && payload.payment_choice,
      availability: payload && payload.availability,
    },
  );
  const missing = [];
  if (policy.next_required_field) missing.push(policy.next_required_field);
  if (Array.isArray(result.missing_required_fields)) {
    for (const f of result.missing_required_fields) {
      if (!missing.includes(f)) missing.push(f);
    }
  }
  return { policy, missing };
}

/**
 * Post-chain reply plan for composer bypass / Cami-first intake.
 */
function buildFrontdeskReplyPlan(input) {
  const inp = input || {};
  const payload = inp.payload || {};
  const prior = inp.prior_guest_context || {};
  const prePlan = inp.frontdesk_pre_plan || {};
  const composed = inp.composed || null;
  const composerState = composed && composed.composer_state;

  const { policy, missing } = computePolicyMissing(payload, prior);
  const activeThread = prior.active_thread || resolveActiveThread(prior);
  const quote = payload.quote || {};
  const paymentChoice = payload.payment_choice || {};

  let replyMode = 'continue_conversation';
  if (composerState && ASK_COMPOSER_STATES.has(composerState)) {
    replyMode = 'ask_missing_naturally';
  } else if (quote.quote_status === 'ready' && paymentChoice.payment_choice_ready !== true) {
    const fields = (payload.result && payload.result.extracted_fields) || {};
    if (policy.next_required_field === 'transfer_info' || missing.includes('transfer_info')) {
      replyMode = 'ask_missing_naturally';
    } else if (policy.next_required_field === 'payment_choice' || missing.includes('payment_choice')
      || fields.booking_ready_to_proceed === true) {
      replyMode = 'ask_missing_naturally';
    } else {
      replyMode = 'quote_ready_warmth';
    }
  } else if (paymentChoice.payment_choice_ready === true) {
    replyMode = 'payment_warmth';
  } else if (activeThread === 'booked' || activeThread === 'post_booking') {
    replyMode = 'post_booking_playground';
  }

  return {
    reply_mode: replyMode,
    composer_state_bypassed: composerState && ASK_COMPOSER_STATES.has(composerState)
      ? composerState
      : null,
    frontdesk_composer_state: replyMode === 'ask_missing_naturally'
      ? 'frontdesk_intake'
      : (replyMode === 'quote_ready_warmth' ? 'frontdesk_quote'
        : (replyMode === 'post_booking_playground' ? 'frontdesk_post_booking' : 'frontdesk_general')),
    active_thread: activeThread,
    missing_fields: prePlan.missing_fields && prePlan.missing_fields.length
      ? prePlan.missing_fields
      : missing,
    next_required_field: policy.next_required_field || null,
    booking_flow_stage: policy.booking_flow_stage || null,
    planner_intent: prePlan.intent || null,
    handoff_required: payload.result && payload.result.safe_handoff_required === true,
    facts_for_cami: {
      check_in: (resultField(payload, 'check_in')),
      check_out: (resultField(payload, 'check_out')),
      guest_count: resultField(payload, 'guest_count'),
      package_interest: resultField(payload, 'package_interest'),
      quote_status: quote.quote_status || 'not_ready',
      quote_total_cents: quote.quote_total_cents || null,
      payment_choice_ready: paymentChoice.payment_choice_ready === true,
    },
  };
}

function resultField(payload, key) {
  const fields = (payload.result && payload.result.extracted_fields)
    || {};
  return fields[key] != null ? fields[key] : null;
}

function buildFrontdeskObservability(prePlan, replyPlan) {
  return {
    frontdesk_planner_enabled: prePlan && prePlan.planner_enabled,
    frontdesk_planner_active: prePlan && prePlan.planner_active,
    frontdesk_planner_used: prePlan && prePlan.planner_used,
    frontdesk_intent: (prePlan && prePlan.intent) || (replyPlan && replyPlan.planner_intent) || null,
    frontdesk_planned_tools: (prePlan && prePlan.planned_tools) || [],
    frontdesk_reply_mode: replyPlan && replyPlan.reply_mode,
    frontdesk_composer_state: replyPlan && replyPlan.frontdesk_composer_state,
    transcript_turns: prePlan && prePlan.transcript_turns,
    transcript_source: prePlan && prePlan.transcript_source,
  };
}

module.exports = {
  FLAG,
  FLAG_PROD,
  ACTIVE_FLAG,
  ASK_COMPOSER_STATES,
  isGuestFrontdeskPlannerEnabled,
  isGuestFrontdeskPlannerActive,
  runGuestFrontdeskPlannerPreChain,
  buildFrontdeskReplyPlan,
  buildFrontdeskObservability,
  applyPlannerFieldSeed,
};
