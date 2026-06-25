'use strict';

/**
 * Owner Insight Agent — LIVE adapter (Phase 2).
 *
 * Wires the model-agnostic agent loop (`owner-insight-agent.js`) to the real model
 * client (`luna-ai-provider`), the real read-only validator, and the real read-only
 * executor (`owner-readonly-sql`), and maps the agent result into the response shape
 * used by `planAndExecuteOwnerSqlQuestion` so it is a drop-in behind a feature flag.
 *
 * Feature flag: OWNER_INSIGHT_AGENT_ENABLED=1 turns the agent path on. Default OFF —
 * with the flag unset, the legacy template planner path is used unchanged (no runtime
 * behavior change, safe to deploy without enabling).
 *
 * Model: uses whatever LUNA_AI_PROVIDER / LUNA_AI_MODEL the runtime is configured
 * with. A capable model is recommended for SQL accuracy (see docs/OWNER-INSIGHT-AGENT.md).
 *
 * @module owner-insight-agent-live
 */

const {
  runOwnerInsightAgent,
  buildOwnerInsightSystemPrompt,
  buildOwnerInsightUserPrompt,
  parsePlannerResponse,
  defaultValidateSql,
} = require('./owner-insight-agent');
const { executeOwnerReadOnlySql } = require('./owner-readonly-sql');
const { callLunaAiJsonChat } = require('./luna-ai-provider');

const BLOCKED_ANSWER = "I can't answer that from the allowed owner data.";

function trimStr(v) { return v == null ? '' : String(v).trim(); }

/** @returns {boolean} whether the agent path is enabled. */
function isOwnerInsightAgentEnabled(env = process.env) {
  return trimStr((env || process.env).OWNER_INSIGHT_AGENT_ENABLED) === '1';
}

function resolveMaxSteps(env) {
  const n = Number(trimStr((env || process.env).OWNER_INSIGHT_AGENT_MAX_STEPS));
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * Map the agent's internal result to the owner SQL response contract so callers
 * (ask-luna execute / bot endpoint) see a familiar shape.
 */
function mapAgentResultToResponse(agentRes, ctx) {
  const showWork = Array.isArray(agentRes.showWork) ? agentRes.showWork : [];
  const lastRows = (() => {
    const steps = Array.isArray(agentRes.steps) ? agentRes.steps : [];
    for (let i = steps.length - 1; i >= 0; i -= 1) if (!steps[i].error) return steps[i].rowsPreview || [];
    return [];
  })();
  const queriesRun = showWork.length;

  const base = {
    question: ctx.question,
    client_slug: ctx.clientSlug,
    planner_source: 'owner_insight_agent',
    answer_format_source: 'owner_insight_agent',
    agent_status: agentRes.status,
    queries_run: queriesRun,
    show_work: showWork,
    read_only: true,
    no_write_performed: true,
    execution: {
      success: agentRes.status === 'ok',
      rows: lastRows,
      row_count: lastRows.length,
      read_only: true,
      no_write_performed: true,
    },
  };

  if (agentRes.status === 'ok') {
    return { ...base, success: true, answer: agentRes.answer, basis: agentRes.basis || null };
  }
  if (agentRes.status === 'needs_clarification') {
    // Surface the clarifying question to the owner; this is a successful turn.
    return { ...base, success: true, answer: agentRes.clarify || 'Could you clarify what you need?', needs_clarification: true };
  }
  // insufficient / exhausted / error — do not fabricate; return the safe blocked answer.
  return {
    ...base,
    success: false,
    answer: BLOCKED_ANSWER,
    error: agentRes.error || agentRes.status || 'agent_failed',
  };
}

/**
 * Run the owner question through the live agent loop.
 *
 * @param {import('pg').Client} pg
 * @param {{ client_slug: string, question: string, env?: object, aiCaller?: Function, maxRows?: number, maxLimit?: number, timeoutMs?: number, maxSteps?: number }} opts
 */
async function runOwnerInsightAgentLive(pg, opts = {}) {
  const env = opts.env || process.env;
  const clientSlug = trimStr(opts.client_slug);
  const question = trimStr(opts.question);
  const aiCaller = typeof opts.aiCaller === 'function' ? opts.aiCaller : callLunaAiJsonChat;
  const maxSteps = Number(opts.maxSteps) > 0 ? Number(opts.maxSteps) : resolveMaxSteps(env);
  // Per-path model override: lets the owner SQL agent run on a stronger model than
  // the runtime-wide LUNA_AI_MODEL, without affecting other staff AI. Empty = inherit.
  const modelOverride = trimStr((env || process.env).OWNER_INSIGHT_AGENT_MODEL) || undefined;

  const system = buildOwnerInsightSystemPrompt({ clientSlug });

  const planStep = async (ctx) => {
    const user = buildOwnerInsightUserPrompt({ question: ctx.question, history: ctx.history });
    let text;
    try {
      text = await aiCaller({
        env,
        system,
        user,
        jsonObject: true,
        temperature: 0,
        maxTokens: 900,
        call_label: 'owner_insight_agent',
        ...(modelOverride ? { model: modelOverride } : {}),
      });
    } catch (err) {
      // Model/transport error — surface as a clarify rather than crashing the turn.
      return { action: 'clarify', question: 'I had trouble reaching the analysis model — could you try again in a moment?' };
    }
    if (text == null) {
      // Provider not configured.
      return { action: 'clarify', question: 'Owner insights are not fully configured yet (no analysis model available).' };
    }
    const decision = parsePlannerResponse(text);
    return decision || { action: 'clarify', question: 'Could you rephrase that question about your data?' };
  };

  const execSql = async (sql, params) => {
    const r = await executeOwnerReadOnlySql(pg, {
      client_slug: clientSlug,
      sql,
      params,
      maxRows: opts.maxRows,
      maxLimit: opts.maxLimit,
      timeoutMs: opts.timeoutMs,
    });
    if (!r.success) {
      const e = new Error(r.detail || r.error || 'query_failed');
      e.code = r.error;
      throw e;
    }
    return { rows: r.rows || [] };
  };

  const agentRes = await runOwnerInsightAgent({
    question,
    clientSlug,
    planStep,
    validateSql: defaultValidateSql,
    execSql,
    maxSteps,
  });

  return mapAgentResultToResponse(agentRes, { clientSlug, question });
}

module.exports = {
  isOwnerInsightAgentEnabled,
  runOwnerInsightAgentLive,
  mapAgentResultToResponse,
  BLOCKED_ANSWER,
};
