/**
 * Phase 11a.3 / 24b — Staff Ask Luna AI answer formatter (presentation only).
 *
 * Formats structured balance-due query rows into natural language for staff.
 * Uses the same AI enablement as intent classification (STAFF_ASK_LUNA_AI_ENABLED + API key).
 * Falls back to deterministic formatter on empty input, disablement, or errors.
 *
 * @module staff-ask-luna-ai-answer-format
 */

'use strict';

const { isAskLunaAiEnabled, SQL_OR_TOOL_RE } = require('./staff-ask-luna-ai-intent');
const { formatAskLunaBalanceDueAnswer } = require('./staff-ask-luna-balance-due');
const { callLunaAiJsonChat } = require('./luna-ai-provider');

const BALANCE_DUE_EMPTY_ANSWER = 'No active bookings currently have a balance due.';
const TABLE_LIKE_RE = /(\|.+\|){2,}|\+[-+]+\+/;

function formatEuro(cents) {
  return `€${(Math.round(Number(cents) || 0) / 100).toFixed(0)}`;
}

function formatStayDates(checkIn, checkOut) {
  const fmt = (d) => {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T12:00:00Z');
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const a = fmt(checkIn);
  const b = fmt(checkOut);
  if (a && b) return `${a}–${b}`;
  return a || b || '';
}

/**
 * Structured summary passed to the formatter (source of truth for AI).
 * @param {object[]} rows
 * @returns {object}
 */
function buildBalanceDueFormatterSummary(rows) {
  const list = rows || [];
  const totalCents = list.reduce((s, r) => s + Number(r.balance_due_cents || 0), 0);
  const bookings = list.map((r) => ({
    guest_name:           r.guest_name || null,
    booking_code:         r.booking_code || null,
    check_in:             r.check_in || null,
    check_out:            r.check_out || null,
    stay_dates:           formatStayDates(r.check_in, r.check_out) || null,
    bed_summary:          r.bed_summary || null,
    balance_due_cents:    Number(r.balance_due_cents || 0),
    balance_due_display:  formatEuro(r.balance_due_cents),
    payment_state_label:  r.payment_state_label || null,
  }));
  bookings.sort((a, b) => Number(b.balance_due_cents) - Number(a.balance_due_cents));
  return {
    intent:                  'payments.balance_due',
    booking_count:           bookings.length,
    total_outstanding_cents: totalCents,
    total_outstanding_display: formatEuro(totalCents),
    bookings,
  };
}

function buildBalanceDueFormatterSystemPrompt() {
  return [
    'You are formatting Staff Ask Luna results for hostel staff.',
    'Use only the structured rows provided in the user message JSON.',
    'Do not invent facts, guests, balances, dates, rooms, payment states, or totals.',
    'Do not generate SQL. Do not mention chat logs or conversations.',
    'Return concise natural language for staff, not a table or markdown grid.',
    'Mention how many bookings have balance due and the total outstanding.',
    'For each guest, include balance due, stay dates, room/bed if present, and payment/link state from the rows.',
    'If booking_count is 0, say no active bookings currently have a balance due.',
  ].join('\n');
}

function collectEuroAmounts(text) {
  const amounts = new Set();
  const re = /€\s*(\d[\d,]*)/g;
  let m;
  const s = String(text || '');
  while ((m = re.exec(s)) !== null) {
    amounts.add(m[1].replace(/,/g, ''));
  }
  return amounts;
}

/**
 * Validate formatter output against structured summary.
 * @returns {string|null} sanitized answer or null to trigger fallback
 */
function validateBalanceDueFormatterOutput(text, summary) {
  const out = String(text || '').trim();
  if (!out || out.length < 24) return null;
  if (SQL_OR_TOOL_RE.test(out) || TABLE_LIKE_RE.test(out)) return null;

  if (!summary || summary.booking_count === 0) {
    return out.toLowerCase().includes('no active bookings') ? out : null;
  }

  const allowedEuros = new Set();
  allowedEuros.add(String(summary.total_outstanding_display || '').replace(/€\s*/i, '').trim());
  for (const b of summary.bookings || []) {
    allowedEuros.add(String(b.balance_due_display || '').replace(/€\s*/i, '').trim());
  }
  allowedEuros.delete('');
  allowedEuros.delete('0');

  const mentioned = collectEuroAmounts(out);
  for (const amt of mentioned) {
    if (!allowedEuros.has(amt)) return null;
  }

  const lower = out.toLowerCase();
  const hasTotal = lower.includes('total outstanding')
    || out.includes(summary.total_outstanding_display);
  if (!hasTotal) return null;

  const names = (summary.bookings || []).flatMap((b) => [
    b.guest_name, b.booking_code,
  ]).filter(Boolean).map((n) => String(n).toLowerCase());
  const mentionsKnownGuest = names.length === 0
    || names.some((n) => lower.includes(n));
  if (!mentionsKnownGuest) return null;

  return out.slice(0, 4000);
}

async function defaultFormatterProvider(summaryJson) {
  const content = await callLunaAiJsonChat({
    env: process.env,
    system: buildBalanceDueFormatterSystemPrompt(),
    user: summaryJson,
    maxTokens: 512,
    temperature: 0.2,
  });
  if (content == null) return null;
  return content;
}

/**
 * Format balance-due rows with AI (presentation only).
 *
 * @param {object[]} rows structured query rows
 * @param {{ provider?: Function }} [opts]
 * @returns {Promise<string|null>}
 */
async function formatBalanceDueAnswerWithAi(rows, opts = {}) {
  if (!isAskLunaAiEnabled()) return null;
  if (!rows || rows.length === 0) return null;

  const summary = buildBalanceDueFormatterSummary(rows);
  const provider = opts.provider || defaultFormatterProvider;
  let rawText;
  try {
    rawText = await provider(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.warn('[ask-luna-ai] balance answer formatter error:', err.message);
    return null;
  }
  if (rawText == null || rawText === '') return null;
  return validateBalanceDueFormatterOutput(rawText, summary);
}

/**
 * AI formatter with deterministic fallback (does not mutate rows).
 *
 * @param {object[]} rows
 * @param {{ provider?: Function }} [opts]
 * @returns {Promise<{ answer: string, answer_format_source: string }>}
 */
async function formatBalanceDueAnswerNatural(rows, opts = {}) {
  if (!rows || rows.length === 0) {
    return {
      answer: BALANCE_DUE_EMPTY_ANSWER,
      answer_format_source: 'deterministic',
    };
  }
  const aiAnswer = await formatBalanceDueAnswerWithAi(rows, opts);
  if (aiAnswer) {
    return { answer: aiAnswer, answer_format_source: 'ai' };
  }
  return {
    answer: formatAskLunaBalanceDueAnswer(rows),
    answer_format_source: 'deterministic',
  };
}

module.exports = {
  BALANCE_DUE_EMPTY_ANSWER,
  buildBalanceDueFormatterSummary,
  buildBalanceDueFormatterSystemPrompt,
  validateBalanceDueFormatterOutput,
  formatBalanceDueAnswerWithAi,
  formatBalanceDueAnswerNatural,
};
