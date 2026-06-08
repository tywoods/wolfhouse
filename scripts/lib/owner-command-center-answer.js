'use strict';

/**
 * Phase 25h — Owner Command Center natural answer formatter.
 *
 * Formats plan + execution rows into WhatsApp-friendly answers.
 * AI when available; deterministic fallback always available.
 *
 * @module owner-command-center-answer
 */

const { resolveLunaAiProvider, callLunaAiJsonChat } = require('./luna-ai-provider');

const MAX_PREVIEW_ROWS = 8;
const BLOCKED_ANSWER = "I can't answer that from the allowed owner data.";
const EMPTY_ANSWER = "I didn't find any matching records.";
const ERROR_ANSWER = "Command Center couldn't run that query right now. Please try again shortly.";

const SENSITIVE_ROW_KEYS = new Set([
  'raw_payload', 'metadata', 'normalized', 'session_state',
  'wa_message_id', 'send_idempotency_key', 'stripe_payment_intent_id',
  'stripe_checkout_session_id', 'whatsapp_message_id',
]);

const SQL_DUMP_RE = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/i;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function formatEuro(cents) {
  return `€${(Math.round(Number(cents) || 0) / 100).toFixed(0)}`;
}

function guardEuroCurrency(text) {
  const out = trimStr(text);
  if (!out) return out;
  if (/\$\s*\d/.test(out)) return null;
  return out;
}

function formatMonthLabel(value) {
  if (!value) return 'this period';
  const d = value instanceof Date ? value : new Date(String(value).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function sanitizeRowForAi(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (SENSITIVE_ROW_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function buildOwnerAnswerSummary(question, planResult, executionResult) {
  const execution = executionResult || planResult?.execution || {};
  const rows = (execution.rows || []).slice(0, 15).map(sanitizeRowForAi);
  return {
    question: trimStr(question),
    template_id: planResult?.plan?.template_id || null,
    planner_source: planResult?.planner_source || null,
    explanation: trimStr(planResult?.plan?.explanation) || null,
    expected_result: trimStr(planResult?.plan?.expected_result) || null,
    row_count: execution.row_count ?? rows.length,
    currency: 'EUR',
    currency_symbol: '€',
    rows,
  };
}

function buildOwnerAnswerSystemPrompt() {
  return [
    'You format Owner Command Center SQL results for WhatsApp.',
    'Use ONLY the JSON summary provided — rows and plan metadata.',
    'Do not invent numbers, guests, dates, totals, or facts not in the data.',
    'Do not mention data that was not provided.',
    'If row_count is 0, say no matching records were found.',
    'Do not expose SQL, table names, or internal column jargon unless essential.',
    'Do not include raw_payload or internal provider IDs.',
    'Keep the answer concise (WhatsApp-friendly): short paragraphs or bullet lines.',
    'If many rows, summarize totals and show at most 5–8 notable items.',
    'Use EUR only — format amounts with the € symbol. Never use $ or USD.',
    'Return plain text only — no markdown fences, no JSON wrapper.',
  ].join('\n');
}

function validateAiOwnerAnswer(text, summary) {
  const out = trimStr(text);
  if (!out || out.length < 8) return null;
  if (SQL_DUMP_RE.test(out) && /\bFROM\b/i.test(out)) return null;
  if (/raw_payload|stripe_|wa_message_id/i.test(out)) return null;
  if (guardEuroCurrency(out) === null) return null;

  if ((summary.row_count || 0) === 0) {
    return /no matching|didn't find|none found|no records/i.test(out) ? out : null;
  }

  const euroRe = /€\s*(\d[\d,]*)/g;
  const allowed = new Set();
  for (const row of summary.rows || []) {
    for (const key of Object.keys(row)) {
      if (/cents$/i.test(key)) {
        allowed.add(String(Math.round(Number(row[key] || 0) / 100)));
      }
    }
  }
  let m;
  while ((m = euroRe.exec(out)) !== null) {
    const amt = m[1].replace(/,/g, '');
    if (allowed.size > 0 && !allowed.has(amt)) return null;
  }

  return out.slice(0, 3500);
}

function formatOutstandingBalancesFallback(rows, rowCount) {
  const totalDue = rows.reduce((s, r) => s + Number(r.balance_due_cents || 0), 0);
  const preview = rows.slice(0, MAX_PREVIEW_ROWS);
  const lines = preview.map((r) => {
    const name = r.guest_name || r.booking_code || 'Guest';
    return `• ${name}: ${formatEuro(r.balance_due_cents)} due`;
  });
  let answer = `${rowCount} booking${rowCount === 1 ? '' : 's'} with outstanding balance (${formatEuro(totalDue)} total).`;
  if (lines.length) answer += `\n${lines.join('\n')}`;
  if (rowCount > MAX_PREVIEW_ROWS) answer += `\n…and ${rowCount - MAX_PREVIEW_ROWS} more.`;
  return { answer, answer_format_source: 'deterministic', row_count: rowCount };
}

function formatRevenueFallback(rows, rowCount) {
  const top = rows[0] || {};
  const monthLabel = formatMonthLabel(top.revenue_month);
  const paid = formatEuro(top.paid_cents);
  const count = Number(top.payment_count || 0);
  let answer = `Revenue for ${monthLabel}: ${paid}`;
  if (count) answer += ` across ${count} payment${count === 1 ? '' : 's'}`;
  answer += '.';
  if (rowCount > 1) {
    const rest = rows.slice(1, 4).map((r) => `${formatMonthLabel(r.revenue_month)}: ${formatEuro(r.paid_cents)}`);
    if (rest.length) answer += `\nOther months: ${rest.join('; ')}.`;
  }
  return { answer, answer_format_source: 'deterministic', row_count: rowCount };
}

function formatPackagePopularityFallback(rows, rowCount) {
  const preview = rows.slice(0, MAX_PREVIEW_ROWS);
  const lines = preview.map((r, i) => {
    const pkg = r.package_code || 'Unknown package';
    const n = Number(r.booking_count || 0);
    return `${i + 1}. ${pkg} — ${n} booking${n === 1 ? '' : 's'}`;
  });
  let answer = `Top package${rowCount === 1 ? '' : 's'} by bookings:`;
  if (lines.length) answer += `\n${lines.join('\n')}`;
  if (rowCount > MAX_PREVIEW_ROWS) answer += `\n…and ${rowCount - MAX_PREVIEW_ROWS} more.`;
  return { answer, answer_format_source: 'deterministic', row_count: rowCount };
}

function formatGenericRowsFallback(rows, rowCount, explanation) {
  const preview = rows.slice(0, MAX_PREVIEW_ROWS);
  const lines = preview.map((r) => {
    const parts = Object.entries(r)
      .filter(([k]) => !SENSITIVE_ROW_KEYS.has(k))
      .slice(0, 4)
      .map(([k, v]) => {
        if (/cents$/i.test(k)) return `${k.replace(/_cents$/i, '')}: ${formatEuro(v)}`;
        return `${k}: ${v}`;
      });
    return `• ${parts.join(', ')}`;
  });
  let answer = trimStr(explanation) || `${rowCount} result${rowCount === 1 ? '' : 's'}:`;
  if (lines.length) answer += `\n${lines.join('\n')}`;
  if (rowCount > MAX_PREVIEW_ROWS) answer += `\n…and ${rowCount - MAX_PREVIEW_ROWS} more.`;
  return { answer, answer_format_source: 'deterministic', row_count: rowCount };
}

/**
 * Deterministic owner answer (no AI).
 *
 * @param {{ question?: string, planResult?: object, executionResult?: object }} opts
 */
function formatOwnerCommandCenterFallback(opts = {}) {
  const planResult = opts.planResult || {};
  const execution = opts.executionResult || planResult.execution || {};
  const validation = planResult.validation || {};
  const plan = planResult.plan || {};

  if (plan.mode === 'unsupported' || validation.valid === false || execution.skipped === true) {
    return { answer: BLOCKED_ANSWER, answer_format_source: 'deterministic', row_count: 0 };
  }

  if (execution.success !== true) {
    return { answer: ERROR_ANSWER, answer_format_source: 'deterministic', row_count: 0 };
  }

  const rows = execution.rows || [];
  const rowCount = execution.row_count ?? rows.length;

  if (rowCount === 0) {
    return { answer: EMPTY_ANSWER, answer_format_source: 'deterministic', row_count: 0 };
  }

  const templateId = plan.template_id;
  if (templateId === 'outstanding_balances') return formatOutstandingBalancesFallback(rows, rowCount);
  if (templateId === 'revenue_summary_by_month') return formatRevenueFallback(rows, rowCount);
  if (templateId === 'package_popularity') return formatPackagePopularityFallback(rows, rowCount);

  return formatGenericRowsFallback(rows, rowCount, plan.explanation);
}

async function formatOwnerCommandCenterAnswerWithAi(summary, env, aiCaller) {
  const cfg = resolveLunaAiProvider(env || process.env);
  if (!cfg.enabled) return null;

  const caller = aiCaller || callLunaAiJsonChat;
  let raw;
  try {
    raw = await caller({
      system: buildOwnerAnswerSystemPrompt(),
      user: JSON.stringify(summary, null, 2),
      env: env || process.env,
      jsonObject: false,
      temperature: 0.2,
      maxTokens: 512,
      call_label: 'owner_command_center_answer',
    });
  } catch {
    return null;
  }

  if (raw == null) return null;
  return validateAiOwnerAnswer(raw, summary);
}

/**
 * Format owner Command Center answer (AI + deterministic fallback).
 *
 * @param {{ question: string, planResult: object, executionResult?: object, client_slug?: string, env?: object, aiCaller?: Function }} opts
 */
async function formatOwnerCommandCenterAnswer(opts = {}) {
  const planResult = opts.planResult || {};
  const executionResult = opts.executionResult || planResult.execution;
  const summary = buildOwnerAnswerSummary(opts.question, planResult, executionResult);

  if (planResult.plan?.mode === 'unsupported'
    || planResult.validation?.valid === false
    || executionResult?.skipped === true) {
    const blocked = formatOwnerCommandCenterFallback({
      question: opts.question,
      planResult,
      executionResult,
    });
    return blocked;
  }

  if (executionResult?.success === true && (summary.row_count || 0) > 0) {
    const aiAnswer = await formatOwnerCommandCenterAnswerWithAi(summary, opts.env, opts.aiCaller);
    if (aiAnswer) {
      return {
        answer: aiAnswer,
        answer_format_source: 'ai',
        row_count: summary.row_count,
      };
    }
  }

  return formatOwnerCommandCenterFallback({
    question: opts.question,
    planResult,
    executionResult,
  });
}

module.exports = {
  BLOCKED_ANSWER,
  EMPTY_ANSWER,
  MAX_PREVIEW_ROWS,
  formatEuro,
  guardEuroCurrency,
  buildOwnerAnswerSummary,
  buildOwnerAnswerSystemPrompt,
  validateAiOwnerAnswer,
  formatOwnerCommandCenterFallback,
  formatOwnerCommandCenterAnswer,
};
