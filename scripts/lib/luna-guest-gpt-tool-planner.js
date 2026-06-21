'use strict';

/**
 * Stage 50c — GPT guest tool planner (read tools only).
 *
 * GPT proposes a read-tool plan; executor runs allowlisted tools.
 * Shadow mode: observability only. Active mode: merge validated field patch before router.
 */

const { callLunaAiJsonChat } = require('./luna-ai-provider');
const {
  GUEST_AGENT_READ_TOOL_IDS,
  isGuestAgentWriteTool,
} = require('./luna-guest-agent-tool-plan');
const { executeGuestAgentReadTool } = require('./luna-guest-agent-tool-executor');
const { mergeGuestExtractedFields, collectPriorExtractedFields } = require('./luna-guest-context-merge');
const { buildSunsetSchoolPromptHint, isSunsetClientSlug } = require('./sunset-luna-school-context');

const FLAG = 'LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED';
const FLAG_PROD = 'LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED_PROD';
const ACTIVE_FLAG = 'LUNA_GUEST_GPT_TOOL_PLANNER_ACTIVE';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_PLANNED_TOOLS = 6;

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isProductionEnv(env) {
  return String((env || {}).NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isGptToolPlannerEnabled(env) {
  const e = env || process.env;
  if (isProductionEnv(e)) return String(e[FLAG_PROD] || '').toLowerCase() === 'true';
  return String(e[FLAG] || '').toLowerCase() === 'true';
}

function isGptToolPlannerActive(env) {
  return isGptToolPlannerEnabled(env) && String((env || process.env)[ACTIVE_FLAG] || '').toLowerCase() === 'true';
}

function plannerModel(env) {
  return trimStr((env || process.env).LUNA_GUEST_GPT_TOOL_PLANNER_MODEL) || DEFAULT_MODEL;
}

function plannerTimeoutMs(env) {
  const v = Number((env || process.env).LUNA_GUEST_GPT_TOOL_PLANNER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 30000) : DEFAULT_TIMEOUT_MS;
}

function buildPlannerSystemPrompt(clientSlug, schoolContext) {
  const readList = GUEST_AGENT_READ_TOOL_IDS.join(', ');
  const lines = [
    'You are Luna guest frontdesk tool planner (Stage 50c).',
    'Plan which READ-ONLY tools should run for this guest turn.',
    `Allowed read tools: ${readList}`,
    'NEVER plan write tools (create_booking_hold, create_payment_link, assign_beds, mark_handoff).',
    'Prefer collect_missing_booking_fields when guest provides booking details.',
    'Use explain_packages when guest asks about packages.',
    'Use get_conversation_context first when prior booking state exists.',
  ];
  if (isSunsetClientSlug(clientSlug)) {
    lines.push('Sunset tenant: use get_sunset_admin_config_snapshot and get_sunset_rental_price for prices/times.');
    if (schoolContext) lines.push(buildSunsetSchoolPromptHint(schoolContext));
  }
  lines.push('Return ONLY JSON: {"planned_tools":["tool_id",...],"rationale":"short reason"}');
  lines.push('Max 6 tools. No prose outside JSON.');
  return lines.join('\n');
}

function buildPlannerUserPrompt(input) {
  return JSON.stringify({
    latest_guest_message: input.message_text,
    prior_extracted_fields: collectPriorExtractedFields(input.prior_guest_context),
    prior_intake_state: (input.prior_guest_context && input.prior_guest_context.result
      && input.prior_guest_context.result.intake_state) || null,
    allowed_read_tools: GUEST_AGENT_READ_TOOL_IDS,
  }, null, 2);
}

function parsePlannerJson(text) {
  const raw = trimStr(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.planned_tools)) return parsed;
  } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*"planned_tools"\s*:\s*\[[^\]]*\]/);
  if (m) {
    try {
      const parsed = JSON.parse(`${m[0]}}`);
      if (parsed && Array.isArray(parsed.planned_tools)) return parsed;
    } catch { /* ignore */ }
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
    const t = setTimeout(() => reject(new Error('gpt_tool_planner_timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function fieldPatchFromResults(toolResults) {
  const collect = (toolResults || []).find((t) => t.tool_id === 'collect_missing_booking_fields' && t.status === 'ok');
  if (!collect || !collect.result) return null;
  const merged = collect.result.merged_extracted_fields;
  if (!merged || !Object.keys(merged).length) return null;
  return merged;
}

function applyPlannerFieldSeed(guestContext, fieldPatch) {
  if (!fieldPatch || !Object.keys(fieldPatch).length) return guestContext || {};
  const prior = guestContext || {};
  const priorFields = collectPriorExtractedFields(prior);
  const merged = mergeGuestExtractedFields(priorFields, fieldPatch);
  return {
    ...prior,
    result: {
      ...(prior.result || {}),
      extracted_fields: merged,
      gpt_planner_field_seed: true,
    },
  };
}

async function defaultPlannerCaller({ system, user, model, env }) {
  return callLunaAiJsonChat({
    system,
    user,
    env: { ...env, LUNA_AI_MODEL: model },
    maxTokens: 256,
    temperature: 0,
    jsonObject: true,
    call_label: 'luna_guest_gpt_tool_planner',
  });
}

/**
 * @param {object} input — message_text, prior_guest_context, client_slug, reference_date, etc.
 * @param {object} [options] — env, plannerCaller, chain_snapshot
 */
async function runGuestGptToolPlanner(input, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const inp = input || {};
  const base = {
    planner_enabled: isGptToolPlannerEnabled(env),
    planner_active: isGptToolPlannerActive(env),
    planner_used: false,
    fallback_used: true,
    planned_tools: [],
    rejected_tools: [],
    tool_results: [],
    field_patch: null,
    rejection_reason: null,
    safety_notes: [],
  };

  if (!base.planner_enabled) {
    base.rejection_reason = 'planner_disabled';
    base.safety_notes.push('flag_off');
    return base;
  }

  const caller = opts.plannerCaller || defaultPlannerCaller;
  const prior = inp.prior_guest_context || {};
  const schoolContext = prior.school_context || inp.school_context || null;
  let rawPlan = null;
  try {
    rawPlan = await withTimeout(
      caller({
        system: buildPlannerSystemPrompt(inp.client_slug, schoolContext),
        user: buildPlannerUserPrompt(inp),
        model: plannerModel(env),
        env,
      }),
      plannerTimeoutMs(env),
    );
  } catch (err) {
    base.rejection_reason = String((err && err.message) || err).slice(0, 120);
    base.safety_notes.push('planner_call_failed');
    return base;
  }

  const parsed = parsePlannerJson(rawPlan);
  if (!parsed) {
    base.rejection_reason = 'unparseable_plan';
    base.safety_notes.push('parse_failed');
    return base;
  }

  const sanitized = sanitizePlannedTools(parsed.planned_tools);
  base.planned_tools = sanitized.planned_tools;
  base.rejected_tools = sanitized.rejected_tools;
  base.planner_rationale = trimStr(parsed.rationale) || null;

  if (!base.planned_tools.length) {
    base.rejection_reason = 'empty_plan';
    return base;
  }

  const execCtx = {
    client_slug: inp.client_slug,
    location_id: inp.location_id || prior.location_id || (schoolContext && schoolContext.location_id) || null,
    school_context: schoolContext,
    message_text: inp.message_text,
    prior_guest_context: inp.prior_guest_context,
    reference_date: inp.reference_date,
    language: inp.language,
    contact_name: inp.contact_name,
    guest_phone: inp.guest_phone,
    env,
    chain_snapshot: opts.chain_snapshot || null,
  };

  const results = [];
  for (const toolId of base.planned_tools) {
    results.push(executeGuestAgentReadTool(toolId, { ...execCtx, tool_id: toolId }));
  }
  base.tool_results = results;
  base.field_patch = fieldPatchFromResults(results);
  base.planner_used = true;
  base.fallback_used = false;
  base.safety_notes.push('read_tools_executed');
  return base;
}

function buildGptToolPlannerObservability(output) {
  const o = output || {};
  return {
    gpt_tool_planner_enabled: o.planner_enabled === true,
    gpt_tool_planner_active: o.planner_active === true,
    gpt_tool_planner_used: o.planner_used === true,
    gpt_tool_planner_fallback_used: o.fallback_used === true,
    gpt_tool_planner_rejection_reason: o.rejection_reason || null,
    gpt_tool_planner_rationale: o.planner_rationale || null,
    gpt_tool_planner_planned_tools: Array.isArray(o.planned_tools) ? o.planned_tools : [],
    gpt_tool_planner_rejected_tools: Array.isArray(o.rejected_tools) ? o.rejected_tools : [],
    gpt_tool_planner_tool_results: Array.isArray(o.tool_results)
      ? o.tool_results.map((t) => ({ tool_id: t.tool_id, status: t.status }))
      : [],
    gpt_tool_planner_field_patch_applied: !!(o.field_patch && Object.keys(o.field_patch).length),
    gpt_tool_planner_safety_notes: Array.isArray(o.safety_notes) ? o.safety_notes : [],
  };
}

module.exports = {
  FLAG,
  FLAG_PROD,
  ACTIVE_FLAG,
  isGptToolPlannerEnabled,
  isGptToolPlannerActive,
  buildPlannerSystemPrompt,
  sanitizePlannedTools,
  parsePlannerJson,
  applyPlannerFieldSeed,
  runGuestGptToolPlanner,
  buildGptToolPlannerObservability,
};
