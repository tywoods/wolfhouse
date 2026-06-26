'use strict';

/**
 * Owner Insight Agent — bounded NL→read-only-SQL reasoning loop.
 *
 * Goal: let Luna read an owner's natural-language question, write her OWN scoped
 * read-only SQL against the curated catalog, observe the rows, optionally refine
 * with another query, and answer — grounded in actual data. This replaces the
 * brittle regex "template picker" (owner-sql-planner) that ignored which month/
 * filter was asked and returned confidently-wrong numbers (e.g. same revenue for
 * June and July).
 *
 * Safe by construction — it reuses the existing safety layer:
 *   - every generated SQL passes `validateOwnerReadOnlySql` (SELECT-only,
 *     client_slug = $1 tenant scope, allowlisted tables/columns, no SELECT *,
 *     LIMIT <= 100) BEFORE it can run,
 *   - execution is read-only + row/time capped (executeOwnerReadOnlySql),
 *   - the agent NEVER returns a final numeric answer unless at least one query
 *     executed successfully (the guard against hallucinated numbers).
 *
 * Dependency-injected so it is model- and DB-agnostic (and unit-testable without
 * an API key or a live database):
 *   - planStep({question, history, clientSlug, step}) -> Promise<decision>
 *       decision = { action: 'query',  sql, rationale? }
 *                | { action: 'answer', answer, basis? }
 *                | { action: 'clarify', question }
 *   - validateSql(sql, clientSlug) -> { ok: boolean, reason?: string, sqlToExecute?: string }
 *   - execSql(sqlToExecute, params) -> Promise<{ rows: object[] }>
 *
 * @module owner-insight-agent
 */

const {
  getOwnerApprovedQueryTemplates,
  describeOwnerCatalogForAi,
} = require('./owner-data-catalog');
const { validateOwnerReadOnlySql } = require('./owner-readonly-sql');

const DEFAULT_MAX_STEPS = 4;
const ROWS_FED_BACK = 25; // rows handed back to the planner per query (keeps prompt bounded)

function trimStr(v) { return v == null ? '' : String(v).trim(); }

/**
 * Default validateSql wrapper around the real owner validator.
 * @param {string} sql
 * @param {string} clientSlug
 * @returns {{ ok: boolean, reason?: string, sqlToExecute?: string }}
 */
function defaultValidateSql(sql, clientSlug) {
  const v = validateOwnerReadOnlySql({ sql, client_slug: clientSlug });
  if (!v.ok) return { ok: false, reason: v.error || v.detail || 'rejected' };
  return { ok: true, sqlToExecute: v.sql_to_execute || sql };
}

/**
 * Run the bounded NL->SQL agent loop.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {string} opts.clientSlug
 * @param {(ctx:object)=>Promise<object>} opts.planStep
 * @param {(sql:string,clientSlug:string)=>object} [opts.validateSql]
 * @param {(sql:string,params:unknown[])=>Promise<{rows:object[]}>} opts.execSql
 * @param {number} [opts.maxSteps]
 * @returns {Promise<object>} result with { status, answer, basis, showWork, steps }
 */
async function runOwnerInsightAgent(opts = {}) {
  const question = trimStr(opts.question);
  const clientSlug = trimStr(opts.clientSlug);
  const planStep = opts.planStep;
  const execSql = opts.execSql;
  const validateSql = typeof opts.validateSql === 'function' ? opts.validateSql : defaultValidateSql;
  const maxSteps = Number(opts.maxSteps) > 0 ? Number(opts.maxSteps) : DEFAULT_MAX_STEPS;

  if (!question) return { status: 'error', error: 'empty_question', answer: null, steps: [] };
  if (!clientSlug) return { status: 'error', error: 'missing_client_slug', answer: null, steps: [] };
  if (typeof planStep !== 'function') return { status: 'error', error: 'missing_planStep', answer: null, steps: [] };
  if (typeof execSql !== 'function') return { status: 'error', error: 'missing_execSql', answer: null, steps: [] };

  const history = []; // [{ sql, rowCount, rowsPreview } | { sql, error }]
  let executedOk = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    let decision;
    try {
      decision = await planStep({ question, history, clientSlug, step });
    } catch (err) {
      return { status: 'error', error: `planner_failed: ${err.message}`, answer: null, steps: history };
    }
    if (!decision || typeof decision !== 'object' || !decision.action) {
      return { status: 'error', error: 'planner_no_decision', answer: null, steps: history };
    }

    if (decision.action === 'clarify') {
      return {
        status: 'needs_clarification',
        answer: null,
        clarify: trimStr(decision.question),
        steps: history,
      };
    }

    if (decision.action === 'answer') {
      // Grounding guard: never emit an answer (with numbers) if nothing was queried.
      if (executedOk === 0) {
        return { status: 'insufficient', error: 'no_grounded_data', answer: null, steps: history };
      }
      return {
        status: 'ok',
        answer: trimStr(decision.answer),
        basis: trimStr(decision.basis),
        showWork: history.filter((h) => !h.error).map((h) => ({ sql: h.sql, rowCount: h.rowCount })),
        steps: history,
      };
    }

    if (decision.action === 'query') {
      const sql = trimStr(decision.sql);
      const v = validateSql(sql, clientSlug);
      if (!v || !v.ok) {
        // Feed the rejection back so the planner can self-correct next step.
        history.push({ sql, error: `invalid_sql: ${(v && v.reason) || 'rejected'}` });
        continue;
      }
      let res;
      try {
        res = await execSql(v.sqlToExecute || sql, [clientSlug]);
      } catch (err) {
        history.push({ sql, error: `exec_failed: ${err.message}` });
        continue;
      }
      const rows = Array.isArray(res && res.rows) ? res.rows : [];
      executedOk += 1;
      history.push({ sql, rowCount: rows.length, rowsPreview: rows.slice(0, ROWS_FED_BACK) });
      continue;
    }

    return { status: 'error', error: `unknown_action: ${decision.action}`, answer: null, steps: history };
  }

  return { status: 'exhausted', error: 'max_steps_reached', answer: null, steps: history };
}

// ---------------------------------------------------------------------------
// Planner prompt construction + response parsing (pure, model-agnostic).
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the SQL-planning model: the catalog, the output
 * contract, the few-shot examples, and the rules that prevent the June/July class
 * of bug (must filter the asked period; must ground answers in rows; clarify when
 * ambiguous; never invent numbers).
 *
 * @param {{ clientSlug?: string, fewShotLimit?: number }} [opts]
 * @returns {string}
 */
function buildOwnerInsightSystemPrompt(opts = {}) {
  const clientSlug = trimStr(opts.clientSlug) || '<client_slug>';
  const fewShotLimit = Number(opts.fewShotLimit) > 0 ? Number(opts.fewShotLimit) : 3;
  const catalog = describeOwnerCatalogForAi({ client_slug: clientSlug });
  const examples = getOwnerApprovedQueryTemplates()
    .filter((t) => t.validation_status === 'approved')
    .slice(0, fewShotLimit)
    .map((t) => `-- ${t.id}: ${t.description}\n${t.sql.trim()}`)
    .join('\n\n');

  return [
    'You are Luna\'s data analyst. You answer an owner\'s question by writing your OWN',
    'read-only SQL against the schema below, reading the results, and answering from',
    'the actual data. BE DECISIVE and FAST: this runs in a live chat with a tight time',
    'budget, so for a clear question write ONE good query and answer from it.',
    '',
    'OUTPUT CONTRACT — respond with a SINGLE JSON object, one of:',
    '  {"action":"query","sql":"<one read-only SELECT>","rationale":"<why>"}',
    '  {"action":"answer","answer":"<plain answer for the owner>","basis":"<what you measured + period>"}',
    '  {"action":"clarify","question":"<one short question>"}',
    '',
    'RULES:',
    '- SELECT-only. Every query MUST filter client_slug = $1 (tenant scope) and LIMIT <= 100.',
    '- Only use tables/columns from the catalog. No SELECT *. No write/DDL keywords.',
    '- ALWAYS filter by exactly the period/dimension the question asks for. If asked',
    '  "for July", the query must restrict to July — never return an unfiltered total.',
    '- Pick the right date column on purpose: check_in (stay date) vs created_at (booked',
    '  date) vs payments.paid_at (cash collected). State which basis you used in "basis".',
    '- Ground every number in rows you actually retrieved. NEVER invent or guess a number.',
    '- BE DECISIVE — strongly prefer answering in a SINGLE query. Do NOT ask to rephrase.',
    '  For occupancy/bed questions ("which beds are booked/occupied/free on a date",',
    '  "who is staying on X"), just query booking_beds occupancy for that date and answer.',
    '  Only use "clarify" when the question is GENUINELY ambiguous (e.g. revenue could mean',
    '  stay-value vs cash collected) — and even then, prefer answering with a stated default',
    '  basis over clarifying. Avoid exploratory pre-queries; go straight to the answer query.',
    '- If a query you ran was rejected or returned nothing useful, try ONE corrected query.',
    '',
    'SCHEMA + SCOPING:',
    catalog,
    '',
    'EXAMPLE SCOPED QUERIES (patterns to imitate, not limits):',
    examples,
    '',
    `Current client_slug ($1) = ${clientSlug}`,
  ].join('\n');
}

/**
 * Build the per-step user prompt: the question + a compact transcript of queries
 * already run and the rows they returned.
 *
 * @param {{ question: string, history?: object[] }} opts
 * @returns {string}
 */
function buildOwnerInsightUserPrompt(opts = {}) {
  const question = trimStr(opts.question);
  const history = Array.isArray(opts.history) ? opts.history : [];
  const lines = [`OWNER QUESTION: ${question}`, ''];
  if (!history.length) {
    lines.push('No queries run yet. Decide your first action.');
  } else {
    lines.push('QUERIES RUN SO FAR:');
    history.forEach((h, i) => {
      lines.push(`[${i + 1}] SQL: ${h.sql}`);
      if (h.error) lines.push(`    -> rejected/error: ${h.error}`);
      else lines.push(`    -> ${h.rowCount} row(s): ${JSON.stringify(h.rowsPreview || []).slice(0, 1500)}`);
    });
    lines.push('', 'Decide your next action (query again, answer, or clarify).');
  }
  return lines.join('\n');
}

/**
 * Parse a model response into a decision object. Tolerates ```json fences and
 * surrounding prose. Returns null if no valid decision is found.
 *
 * @param {string} text
 * @returns {object|null}
 */
function parsePlannerResponse(text) {
  const raw = trimStr(text);
  if (!raw) return null;
  let candidate = null;

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  if (!candidate) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) candidate = raw.slice(start, end + 1);
  }
  if (!candidate) return null;

  let obj;
  try { obj = JSON.parse(candidate); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!['query', 'answer', 'clarify'].includes(obj.action)) return null;
  return obj;
}

/**
 * Build a planStep from an injected model call. `callModel({system,user})` must
 * return the model's text. Keeping the SDK out of this module makes the agent
 * model-agnostic (OpenAI, Anthropic, etc.) and testable with a stub.
 *
 * @param {{ callModel: (m:{system:string,user:string})=>Promise<string>, clientSlug: string }} cfg
 * @returns {(ctx:object)=>Promise<object>}
 */
function makeLlmPlanner(cfg = {}) {
  const callModel = cfg.callModel;
  const clientSlug = trimStr(cfg.clientSlug);
  if (typeof callModel !== 'function') throw new Error('makeLlmPlanner requires callModel');
  const system = buildOwnerInsightSystemPrompt({ clientSlug });
  return async function planStep(ctx) {
    const user = buildOwnerInsightUserPrompt({ question: ctx.question, history: ctx.history });
    const text = await callModel({ system, user });
    const decision = parsePlannerResponse(text);
    if (!decision) return { action: 'clarify', question: 'Sorry — could you rephrase that question about your data?' };
    return decision;
  };
}

module.exports = {
  DEFAULT_MAX_STEPS,
  runOwnerInsightAgent,
  defaultValidateSql,
  buildOwnerInsightSystemPrompt,
  buildOwnerInsightUserPrompt,
  parsePlannerResponse,
  makeLlmPlanner,
};
