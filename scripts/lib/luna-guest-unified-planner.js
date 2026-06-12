'use strict';

/**
 * Stage D — unified planner mode: one GPT planner owns intent; other brains stay deterministic.
 *
 * When LUNA_GUEST_UNIFIED_PLANNER_MODE=true and frontdesk planner is active:
 * - Conversation brain LLM is disabled (deterministic classifier only)
 * - GPT tool planner is skipped (frontdesk planner already ran)
 * - Agent brain stays narrow (paid change / payment mismatch only)
 * - Cami stays voice-only (validated rewrite, no replanning)
 */

const { isGuestFrontdeskPlannerActive } = require('./luna-guest-frontdesk-planner');

const FLAG = 'LUNA_GUEST_UNIFIED_PLANNER_MODE';
const FLAG_PROD = 'LUNA_GUEST_UNIFIED_PLANNER_MODE_PROD';

function isProductionEnv(env) {
  return String((env || process.env).NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isUnifiedPlannerModeEnabled(env) {
  const e = env || process.env;
  if (isProductionEnv(e)) return String(e[FLAG_PROD] || '').toLowerCase() === 'true';
  return String(e[FLAG] || '').toLowerCase() === 'true';
}

function isUnifiedPlannerActive(env) {
  return isUnifiedPlannerModeEnabled(env) && isGuestFrontdeskPlannerActive(env);
}

/**
 * Env overrides for orchestrator when unified planner is the sole intent owner.
 */
function applyUnifiedPlannerEnv(baseEnv) {
  const env = { ...(baseEnv || process.env) };
  if (!isUnifiedPlannerActive(env)) return env;
  env.LUNA_CONVERSATION_BRAIN_LLM_ENABLED = 'false';
  env.LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED = 'false';
  env.LUNA_GUEST_GPT_TOOL_PLANNER_ACTIVE = 'false';
  return env;
}

module.exports = {
  FLAG,
  FLAG_PROD,
  isUnifiedPlannerModeEnabled,
  isUnifiedPlannerActive,
  applyUnifiedPlannerEnv,
};
