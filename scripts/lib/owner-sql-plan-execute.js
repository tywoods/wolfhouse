'use strict';

/**
 * Phase 25g — Owner Command Center plan-and-execute orchestration.
 *
 * Plans via owner-sql-planner, executes only when validation passes.
 * Plan-only dry-run remains on POST /staff/owner/sql/plan.
 *
 * @module owner-sql-plan-execute
 */

const { planOwnerSqlQuestion } = require('./owner-sql-planner');
const { executeOwnerReadOnlySql } = require('./owner-readonly-sql');

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function safeExecDetail(detail) {
  if (detail == null) return null;
  const s = String(detail);
  if (s.length <= 160) return s;
  return `${s.slice(0, 157)}...`;
}

function buildBlockedResponse(planResult) {
  const reason = planResult.validation?.blocked_reason
    || planResult.validation?.reason
    || planResult.error
    || 'plan_not_executable';

  return {
    success: false,
    question: planResult.question,
    client_slug: planResult.client_slug,
    planner_source: planResult.planner_source,
    plan: planResult.plan,
    validation: planResult.validation,
    execution: {
      success: false,
      skipped: true,
      reason,
      rows: [],
      row_count: 0,
      read_only: true,
      no_write_performed: true,
    },
    execute_ready: false,
    no_query_executed: true,
    read_only: true,
    no_write_performed: true,
    error: reason,
    detail: planResult.detail || planResult.plan?.explanation || null,
  };
}

/**
 * Plan an owner question and execute read-only SQL when validation passes.
 *
 * @param {import('pg').Client} pg
 * @param {{ client_slug: string, question: string, role?: string, maxRows?: number, maxLimit?: number, timeoutMs?: number, env?: object, aiCaller?: Function }} opts
 */
async function planAndExecuteOwnerSqlQuestion(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const question = trimStr(opts.question);
  const maxRows = Number(opts.maxRows) > 0 ? Number(opts.maxRows) : undefined;
  const maxLimit = Number(opts.maxLimit) > 0 ? Number(opts.maxLimit) : undefined;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : undefined;

  const planResult = await planOwnerSqlQuestion({
    client_slug: clientSlug,
    question,
    role: opts.role || 'owner',
    env: opts.env || process.env,
    aiCaller: opts.aiCaller,
  });

  if (!planResult.execute_ready || planResult.validation?.valid !== true) {
    return buildBlockedResponse(planResult);
  }

  const execResult = await executeOwnerReadOnlySql(pg, {
    client_slug: clientSlug,
    sql: planResult.plan.sql,
    params: planResult.plan.params,
    maxRows,
    maxLimit,
    timeoutMs,
  });

  return {
    success: execResult.success === true,
    question: planResult.question,
    client_slug: planResult.client_slug,
    planner_source: planResult.planner_source,
    plan: planResult.plan,
    validation: planResult.validation,
    execution: {
      success: execResult.success === true,
      rows: execResult.rows || [],
      row_count: execResult.row_count ?? (execResult.rows || []).length,
      limited: execResult.limited === true,
      elapsed_ms: execResult.elapsed_ms,
      read_only: true,
      no_write_performed: true,
      error: execResult.success ? null : execResult.error || 'query_failed',
      detail: execResult.success ? null : safeExecDetail(execResult.detail),
      sql_summary: execResult.sql_summary || null,
    },
    execute_ready: true,
    no_query_executed: false,
    read_only: true,
    no_write_performed: true,
  };
}

module.exports = {
  planAndExecuteOwnerSqlQuestion,
  buildBlockedResponse,
  safeExecDetail,
};
