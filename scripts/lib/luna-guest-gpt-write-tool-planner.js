'use strict';

/**
 * Stage 50d/50e — GPT guest write tool planner (post-chain).
 *
 * Merges deterministic write plan with optional GPT rationale.
 * Shadow: plan + gate eval only. Active: execute when confirm_* + pg present.
 */

const { callLunaAiJsonChat } = require('./luna-ai-provider');
const {
  GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS,
  isGuestAgentGptPlannableWriteTool,
} = require('./luna-guest-agent-tool-plan');
const {
  buildDeterministicWriteToolPlan,
  evaluateWriteToolReadiness,
  executeGuestAgentWriteTool,
} = require('./luna-guest-agent-write-tool-executor');

const FLAG = 'LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED';
const FLAG_PROD = 'LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED_PROD';
const ACTIVE_FLAG = 'LUNA_GUEST_GPT_WRITE_TOOLS_ACTIVE';
const SERVICE_PAY_FLAG = 'LUNA_GUEST_SERVICE_PAY_NOW_ENABLED';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 6000;

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isProductionEnv(env) {
  return String((env || {}).NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isGptWriteToolPlannerEnabled(env) {
  const e = env || process.env;
  if (isProductionEnv(e)) return String(e[FLAG_PROD] || '').toLowerCase() === 'true';
  return String(e[FLAG] || '').toLowerCase() === 'true';
}

function isGptWriteToolPlannerActive(env) {
  return isGptWriteToolPlannerEnabled(env)
    && String((env || process.env)[ACTIVE_FLAG] || '').toLowerCase() === 'true';
}

function isGuestServicePayNowEnabled(env) {
  return String((env || process.env)[SERVICE_PAY_FLAG] || '').toLowerCase() === 'true';
}

function plannerModel(env) {
  return trimStr((env || process.env).LUNA_GUEST_GPT_WRITE_TOOLS_MODEL) || DEFAULT_MODEL;
}

function plannerTimeoutMs(env) {
  const v = Number((env || process.env).LUNA_GUEST_GPT_WRITE_TOOLS_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 30000) : DEFAULT_TIMEOUT_MS;
}

function buildWritePlannerSystemPrompt() {
  const list = GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS.join(', ');
  return [
    'You are Luna guest write tool planner (Stage 50d/50e).',
    'Given chain snapshot + guest message, suggest which WRITE tools should run.',
    `Allowed write tools: ${list}`,
    'Only plan writes when chain snapshot shows readiness (payment_choice_ready, hold plan ready, or existing booking_id for add-ons).',
    'When booking_id is present AND meals_request or yoga_request is non-null in chain_status, you MUST plan attach_post_booking_services.',
    'NEVER plan assign_beds or mark_handoff.',
    'Order: create_booking_hold before create_payment_link; attach_post_booking_services before create_service_payment_link.',
    'Return ONLY JSON: {"planned_tools":["tool_id",...],"rationale":"short reason"}',
    'Max 4 tools. No prose outside JSON.',
  ].join('\n');
}

function buildWritePlannerUserPrompt(input) {
  const snap = input.chain_snapshot || {};
  const extractedFields = (snap.result && snap.result.extracted_fields) || {};
  return JSON.stringify({
    latest_guest_message: input.message_text,
    chain_status: {
      payment_choice_ready: snap.payment_choice && snap.payment_choice.payment_choice_ready,
      next_safe_step: snap.payment_choice && snap.payment_choice.next_safe_step,
      hold_plan_status: snap.hold_payment_draft_plan && snap.hold_payment_draft_plan.plan_status,
      quote_status: snap.quote && snap.quote.quote_status,
      booking_id: input.booking_id || null,
      meals_request: extractedFields.meals_request || null,
      yoga_request: extractedFields.yoga_request || null,
    },
    allowed_write_tools: GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS,
    service_pay_now_enabled: input.service_pay_now_enabled === true,
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

function sanitizeGptWritePlan(planned) {
  const out = [];
  const rejected = [];
  for (const t of planned || []) {
    const id = trimStr(t);
    if (!id) continue;
    if (!isGuestAgentGptPlannableWriteTool(id)) {
      rejected.push({ tool_id: id, reason: 'not_plannable_write_tool' });
      continue;
    }
    if (!out.includes(id)) out.push(id);
    if (out.length >= 4) break;
  }
  return { planned_tools: out, rejected_tools: rejected };
}

function mergeWritePlans(deterministicSteps, gptTools) {
  const order = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  for (const step of deterministicSteps || []) push(step.tool_id);
  for (const id of gptTools || []) push(id);
  return order;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gpt_write_tool_planner_timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function defaultWritePlannerCaller({ system, user, model, env }) {
  return callLunaAiJsonChat({
    system,
    user,
    env: { ...env, LUNA_AI_MODEL: model },
    maxTokens: 256,
    temperature: 0,
    jsonObject: true,
    call_label: 'luna_guest_gpt_write_tool_planner',
  });
}

/**
 * @param {object} input — message_text, chain_snapshot, booking_id, client_slug, etc.
 * @param {object} [options] — env, writePlannerCaller, exec_ctx (confirm flags, pg)
 */
async function runGuestGptWriteToolPlanner(input, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const inp = input || {};
  const chainSnapshot = inp.chain_snapshot || {};
  const execCtx = {
    ...(opts.exec_ctx || {}),
    env,
    message_text: inp.message_text,
    client_slug: inp.client_slug,
    guest_phone: inp.guest_phone,
    contact_name: inp.contact_name,
    prior_guest_context: inp.prior_guest_context,
    live_outcomes: opts.live_outcomes || (opts.exec_ctx && opts.exec_ctx.live_outcomes),
  };

  const base = {
    write_planner_enabled: isGptWriteToolPlannerEnabled(env),
    write_planner_active: isGptWriteToolPlannerActive(env),
    service_pay_now_enabled: isGuestServicePayNowEnabled(env),
    write_planner_used: false,
    fallback_used: true,
    deterministic_plan: [],
    planned_tools: [],
    rejected_tools: [],
    readiness: [],
    tool_results: [],
    write_outcomes: {},
    rejection_reason: null,
    safety_notes: [],
  };

  const deterministic = buildDeterministicWriteToolPlan(chainSnapshot, execCtx);
  base.deterministic_plan = deterministic;

  if (!base.write_planner_enabled) {
    base.rejection_reason = 'write_planner_disabled';
    base.safety_notes.push('flag_off');
    base.planned_tools = deterministic.map((s) => s.tool_id);
    for (const toolId of base.planned_tools) {
      base.readiness.push(evaluateWriteToolReadiness(toolId, chainSnapshot, execCtx));
    }
    return base;
  }

  let gptTools = [];
  let rationale = null;
  const caller = opts.writePlannerCaller || defaultWritePlannerCaller;
  try {
    const raw = await withTimeout(
      caller({
        system: buildWritePlannerSystemPrompt(),
        user: buildWritePlannerUserPrompt({
          ...inp,
          chain_snapshot: chainSnapshot,
          service_pay_now_enabled: base.service_pay_now_enabled,
        }),
        model: plannerModel(env),
        env,
      }),
      plannerTimeoutMs(env),
    );
    const parsed = parsePlannerJson(raw);
    if (parsed) {
      const sanitized = sanitizeGptWritePlan(parsed.planned_tools);
      gptTools = sanitized.planned_tools;
      base.rejected_tools = sanitized.rejected_tools;
      rationale = trimStr(parsed.rationale) || null;
    } else {
      base.safety_notes.push('gpt_parse_failed_use_deterministic');
    }
  } catch (err) {
    base.safety_notes.push('gpt_call_failed_use_deterministic');
    base.rejection_reason = String((err && err.message) || err).slice(0, 120);
  }

  base.planned_tools = mergeWritePlans(deterministic, gptTools);
  base.planner_rationale = rationale;
  base.write_planner_used = base.planned_tools.length > 0;
  base.fallback_used = !rationale && gptTools.length === 0;

  for (const toolId of base.planned_tools) {
    base.readiness.push(evaluateWriteToolReadiness(toolId, chainSnapshot, execCtx));
  }

  if (!base.write_planner_active) {
    base.safety_notes.push('shadow_mode_no_execution');
    return base;
  }

  const outcomes = {};
  let holdPaymentDraftId = execCtx.payment_draft_id || null;
  let holdBookingId = execCtx.booking_id || null;

  for (const toolId of base.planned_tools) {
    const stepCtx = {
      ...execCtx,
      hold_write_outcome: outcomes.create_booking_hold,
      live_outcomes: {
        hold_write: outcomes.create_booking_hold,
        booking_write: outcomes.create_booking_hold,
        stripe_link: outcomes.create_payment_link,
      },
    };
    if (holdPaymentDraftId) stepCtx.payment_draft_id = holdPaymentDraftId;
    if (holdBookingId) stepCtx.booking_id = holdBookingId;

    const result = await executeGuestAgentWriteTool(toolId, chainSnapshot, stepCtx);
    base.tool_results.push(result);

    if (result.status === 'ok' && result.result) {
      outcomes[toolId] = result.result;
      if (toolId === 'create_booking_hold') {
        holdPaymentDraftId = result.result.payment_draft_id || holdPaymentDraftId;
        holdBookingId = result.result.booking_id || holdBookingId;
      }
      if (toolId === 'attach_post_booking_services' && result.result.service_payment_ledger) {
        outcomes.service_payment_ledger = result.result.service_payment_ledger;
      }
    } else if (result.status === 'planned') {
      base.safety_notes.push(`${toolId}_would_execute_missing_confirm_or_pg`);
    } else if (result.status === 'blocked' || result.status === 'error') {
      base.safety_notes.push(`${toolId}_${result.status}`);
      if (toolId === 'create_booking_hold') break;
    }
  }

  base.write_outcomes = outcomes;
  if (base.tool_results.some((t) => t.status === 'ok')) {
    base.safety_notes.push('write_tools_executed');
  }
  return base;
}

function buildGptWriteToolPlannerObservability(output) {
  const o = output || {};
  return {
    gpt_write_tool_planner_enabled: o.write_planner_enabled === true,
    gpt_write_tool_planner_active: o.write_planner_active === true,
    gpt_write_tool_planner_used: o.write_planner_used === true,
    gpt_write_tool_planner_fallback_used: o.fallback_used === true,
    gpt_write_tool_planner_rejection_reason: o.rejection_reason || null,
    gpt_write_tool_planner_rationale: o.planner_rationale || null,
    gpt_write_tool_planner_planned_tools: Array.isArray(o.planned_tools) ? o.planned_tools : [],
    gpt_write_tool_planner_rejected_tools: Array.isArray(o.rejected_tools) ? o.rejected_tools : [],
    gpt_write_tool_planner_deterministic_plan: Array.isArray(o.deterministic_plan) ? o.deterministic_plan : [],
    gpt_write_tool_planner_readiness: Array.isArray(o.readiness) ? o.readiness : [],
    gpt_write_tool_planner_tool_results: Array.isArray(o.tool_results)
      ? o.tool_results.map((t) => ({ tool_id: t.tool_id, status: t.status }))
      : [],
    gpt_write_tool_planner_write_outcomes_keys: o.write_outcomes
      ? Object.keys(o.write_outcomes)
      : [],
    gpt_write_tool_planner_service_pay_now_enabled: o.service_pay_now_enabled === true,
    gpt_write_tool_planner_safety_notes: Array.isArray(o.safety_notes) ? o.safety_notes : [],
  };
}

module.exports = {
  FLAG,
  FLAG_PROD,
  ACTIVE_FLAG,
  SERVICE_PAY_FLAG,
  isGptWriteToolPlannerEnabled,
  isGptWriteToolPlannerActive,
  isGuestServicePayNowEnabled,
  sanitizeGptWritePlan,
  buildDeterministicWriteToolPlan,
  runGuestGptWriteToolPlanner,
  buildGptWriteToolPlannerObservability,
};
