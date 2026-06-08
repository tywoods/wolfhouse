'use strict';

/**
 * Phase 25f — Owner Command Center AI SQL planner (dry-run only).
 *
 * Plans owner BI questions against the data catalog and validator.
 * Does NOT execute SQL — execution is Stage 25g.
 *
 * @module owner-sql-planner
 */

const {
  describeOwnerCatalogForAi,
  getOwnerApprovedQueryTemplates,
} = require('./owner-data-catalog');
const { validateOwnerReadOnlySql } = require('./owner-readonly-sql');
const { resolveLunaAiProvider, callLunaAiJsonChat } = require('./luna-ai-provider');

const APPROVED_TEMPLATE_MATCHERS = Object.freeze([
  {
    id: 'outstanding_balances',
    test: (q) => /\b(outstanding|who owes|hasn't settled|haven't settled|unsettled|not settled|settled up|balance due|owe money|owing money|hasn't paid|haven't paid)\b/i.test(q),
  },
  {
    id: 'revenue_summary_by_month',
    test: (q) => /\b(revenue|paid this month|income this month|money this month|earnings this month|how much.*this month)\b/i.test(q),
  },
  {
    id: 'arrivals_tomorrow',
    test: (q) => /\b(arriv(?:e|al)s tomorrow|checking in tomorrow|check in tomorrow|who arrives tomorrow|arrivals tomorrow)\b/i.test(q),
  },
  {
    id: 'package_popularity',
    test: (q) => /\b(most popular package|package popularity|popular package|which package|package.*popular)\b/i.test(q),
  },
  {
    id: 'addon_revenue',
    test: (q) => /\b(add[- ]?on revenue|addon revenue|service revenue|add on revenue|add-on revenue)\b/i.test(q),
  },
  {
    id: 'bookings_by_source',
    test: (q) => /\b(bookings by source|booking source|source of bookings|where bookings come from)\b/i.test(q),
  },
]);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function getApprovedTemplates() {
  return getOwnerApprovedQueryTemplates().filter((t) => t.validation_status === 'approved');
}

function templateById(id) {
  return getApprovedTemplates().find((t) => t.id === id) || null;
}

function extractJsonObjectText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function matchTemplateByQuestion(question) {
  const q = trimStr(question);
  if (!q) return null;
  for (const entry of APPROVED_TEMPLATE_MATCHERS) {
    if (entry.test(q)) return entry.id;
  }
  return null;
}

function buildParamsForTemplate(tmpl, clientSlug) {
  const params = [clientSlug];
  if (!tmpl) return params;
  if (tmpl.required_params.includes('arrival_date')) params.push('2026-09-24');
  if (tmpl.required_params.includes('checkout_date')) params.push('2026-09-27');
  if (tmpl.required_params.includes('occupancy_date')) params.push('2026-09-24');
  return params;
}

function expectedResultShape(tmpl) {
  if (!tmpl || !tmpl.expected_row_shape) return '';
  return Object.keys(tmpl.expected_row_shape).join(', ');
}

/**
 * @param {{ client_slug?: string, question: string, catalog?: string }} opts
 */
function buildOwnerSqlPlannerPrompt(opts = {}) {
  const clientSlug = trimStr(opts.client_slug) || '<client_slug>';
  const question = trimStr(opts.question);
  const catalog = trimStr(opts.catalog) || describeOwnerCatalogForAi({ client_slug: clientSlug });
  const templates = getApprovedTemplates();
  const templateLines = templates.map((t) => (
    `- ${t.id}: ${t.description} (params: ${t.required_params.join(', ')})`
  ));

  const system = [
    'You are the Owner Command Center SQL planner (Phase 25f dry-run).',
    'Return JSON only — no prose, no markdown fences.',
    '',
    'Rules:',
    '- Prefer approved template_id when the question matches.',
    '- mode=template: set template_id and copy SQL/params from catalog templates.',
    '- mode=sql: emit read-only SELECT only when no template fits.',
    '- mode=unsupported: when the question cannot be answered safely.',
    '- Use only catalog tables/columns.',
    '- Never SELECT *, raw_payload, metadata, normalized, session_state, Stripe/WhatsApp provider IDs.',
    '- Always include client_slug = $1 in SQL; params[0] must equal client_slug.',
    '- Row-returning queries must include LIMIT <= 100.',
    '- Never write data (no INSERT/UPDATE/DELETE).',
    '',
    'JSON shape:',
    '{',
    '  "mode": "template" | "sql" | "unsupported",',
    '  "template_id": string | null,',
    '  "sql": string,',
    '  "params": string[],',
    '  "explanation": string,',
    '  "expected_result": string,',
    '  "confidence": number',
    '}',
  ].join('\n');

  const user = [
    catalog,
    '',
    'Approved templates:',
    ...templateLines,
    '',
    `client_slug: ${clientSlug}`,
    `question: ${question}`,
  ].join('\n');

  return { system, user, catalog, templates };
}

function normalizePlanShape(raw, clientSlug) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = trimStr(raw.mode).toLowerCase();
  if (!['template', 'sql', 'unsupported'].includes(mode)) return null;

  let templateId = raw.template_id != null ? trimStr(raw.template_id) : null;
  let sql = trimStr(raw.sql);
  let params = Array.isArray(raw.params) ? raw.params.map((p) => trimStr(p)) : [clientSlug];

  if (mode === 'template' && templateId) {
    const tmpl = templateById(templateId);
    if (!tmpl) return null;
    sql = tmpl.sql;
    params = buildParamsForTemplate(tmpl, clientSlug);
  }

  if (mode === 'unsupported') {
    return {
      mode: 'unsupported',
      template_id: null,
      sql: '',
      params: [clientSlug],
      explanation: trimStr(raw.explanation) || 'Question cannot be answered with owner catalog.',
      expected_result: '',
      confidence: Number(raw.confidence) || 0,
    };
  }

  if (!sql) return null;

  if (params.length < 1 || params[0] !== clientSlug) {
    params = [clientSlug, ...params.filter((p) => p !== clientSlug)];
  }

  return {
    mode,
    template_id: mode === 'template' ? templateId : null,
    sql,
    params,
    explanation: trimStr(raw.explanation) || '',
    expected_result: trimStr(raw.expected_result) || '',
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0.75)),
  };
}

function buildPlanFromTemplate(templateId, clientSlug) {
  const tmpl = templateById(templateId);
  if (!tmpl) return null;
  return {
    mode: 'template',
    template_id: templateId,
    sql: tmpl.sql,
    params: buildParamsForTemplate(tmpl, clientSlug),
    explanation: tmpl.description,
    expected_result: expectedResultShape(tmpl),
    confidence: 0.92,
  };
}

/**
 * @param {object|null} plan
 * @param {{ client_slug: string }} opts
 */
function validateOwnerSqlPlan(plan, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  if (!plan || plan.mode === 'unsupported') {
    return {
      valid: false,
      reason: 'unsupported',
      blocked_reason: 'unsupported_question',
      detail: plan?.explanation || 'No executable plan',
    };
  }

  if (!trimStr(plan.sql)) {
    return {
      valid: false,
      reason: 'sql_missing',
      blocked_reason: 'sql_missing',
      detail: 'Plan has no SQL',
    };
  }

  const validation = validateOwnerReadOnlySql({
    sql: plan.sql,
    client_slug: clientSlug,
  });

  return {
    valid: validation.ok === true,
    reason: validation.ok ? 'passed_validator' : validation.error,
    blocked_reason: validation.ok ? null : validation.error,
    detail: validation.detail || null,
    validation,
  };
}

function buildPlannerResponse({
  success,
  plannerSource,
  question,
  plan,
  validation,
  clientSlug,
  error,
  detail,
}) {
  const executeReady = !!(plan && plan.mode !== 'unsupported' && validation && validation.valid);
  return {
    success: success === true,
    planner_source: plannerSource || 'fallback',
    question,
    client_slug: clientSlug,
    plan: plan || {
      mode: 'unsupported',
      template_id: null,
      sql: '',
      params: [clientSlug],
      explanation: detail || error || 'No plan',
      expected_result: '',
      confidence: 0,
    },
    validation: validation || {
      valid: false,
      reason: error || 'no_plan',
      blocked_reason: error || 'no_plan',
    },
    execute_ready: executeReady,
    no_query_executed: true,
    read_only: true,
    no_write_performed: true,
    error: error || null,
    detail: detail || null,
  };
}

async function planWithAi(question, clientSlug, env, aiCaller) {
  const prompt = buildOwnerSqlPlannerPrompt({ client_slug: clientSlug, question });
  const caller = aiCaller || callLunaAiJsonChat;
  const raw = await caller({
    system: prompt.system,
    user: prompt.user,
    env,
    jsonObject: true,
    temperature: 0,
    maxTokens: 512,
    call_label: 'owner_sql_planner',
  });
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(extractJsonObjectText(raw));
  } catch {
    return null;
  }
  return normalizePlanShape(parsed, clientSlug);
}

/**
 * Plan an owner BI question (dry-run — never executes SQL).
 *
 * @param {{ client_slug: string, question: string, role?: string, env?: object, aiCaller?: Function }} opts
 */
async function planOwnerSqlQuestion(opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const question = trimStr(opts.question);
  const role = trimStr(opts.role) || 'owner';
  const env = opts.env || process.env;

  if (!clientSlug) {
    return buildPlannerResponse({
      success: false,
      plannerSource: 'fallback',
      question,
      clientSlug: '',
      error: 'client_slug_required',
      detail: 'client_slug is required',
    });
  }

  if (!question) {
    return buildPlannerResponse({
      success: false,
      plannerSource: 'fallback',
      question: '',
      clientSlug,
      error: 'question_required',
      detail: 'question is required',
    });
  }

  if (role !== 'owner') {
    return buildPlannerResponse({
      success: false,
      plannerSource: 'fallback',
      question,
      clientSlug,
      error: 'role_not_allowed',
      detail: 'Only owner role is supported in 25f',
    });
  }

  const templateId = matchTemplateByQuestion(question);
  if (templateId) {
    const plan = buildPlanFromTemplate(templateId, clientSlug);
    const validation = validateOwnerSqlPlan(plan, { client_slug: clientSlug });
    return buildPlannerResponse({
      success: true,
      plannerSource: 'template_match',
      question,
      plan,
      validation,
      clientSlug,
    });
  }

  const aiCfg = resolveLunaAiProvider(env);
  if (aiCfg.enabled) {
    const aiPlan = await planWithAi(question, clientSlug, env, opts.aiCaller);
    if (aiPlan) {
      const validation = validateOwnerSqlPlan(aiPlan, { client_slug: clientSlug });
      return buildPlannerResponse({
        success: aiPlan.mode !== 'unsupported',
        plannerSource: 'ai',
        question,
        plan: aiPlan,
        validation,
        clientSlug,
      });
    }
  }

  return buildPlannerResponse({
    success: false,
    plannerSource: 'fallback',
    question,
    clientSlug,
    plan: {
      mode: 'unsupported',
      template_id: null,
      sql: '',
      params: [clientSlug],
      explanation: 'No approved template matched and AI planner is unavailable.',
      expected_result: '',
      confidence: 0,
    },
    validation: {
      valid: false,
      reason: 'unsupported',
      blocked_reason: 'unsupported_question',
    },
  });
}

module.exports = {
  APPROVED_TEMPLATE_MATCHERS,
  buildOwnerSqlPlannerPrompt,
  matchTemplateByQuestion,
  buildPlanFromTemplate,
  validateOwnerSqlPlan,
  planOwnerSqlQuestion,
  normalizePlanShape,
};
