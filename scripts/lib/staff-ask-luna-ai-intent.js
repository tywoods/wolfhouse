/**
 * Phase 11a.2 / 24a — Staff Ask Luna AI intent classifier (registry-only).
 *
 * Classifies staff questions into existing read-only registry intent keys only.
 * Does not generate SQL, answers, or use conversation/chat logs.
 *
 * Enable: API key present (OpenAI or Anthropic), or STAFF_ASK_LUNA_AI_ENABLED=true.
 * Explicit STAFF_ASK_LUNA_AI_ENABLED=false disables even when keys exist.
 *
 * @module staff-ask-luna-ai-intent
 */

'use strict';

const { getEntry, INTENT_KEYS } = require('./staff-query-registry');
const {
  resolveLunaAiProvider,
  callLunaAiJsonChat,
} = require('./luna-ai-provider');

const DEFAULT_CONFIDENCE_MIN = 0.75;

const SQL_OR_TOOL_RE = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b|```|`{3,}|tool_use|tool_call|"tool"\s*:|function_call/i;

function isAskLunaAiEnabled(env) {
  const e = env || process.env;
  const v = String(e.STAFF_ASK_LUNA_AI_ENABLED || '').trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return resolveLunaAiProvider(e).enabled;
}

function getConfidenceMin() {
  const n = Number(process.env.STAFF_ASK_LUNA_AI_CONFIDENCE_MIN);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_CONFIDENCE_MIN;
}

/**
 * Registry intent keys safe for Ask Luna (read-only, helper present).
 * @returns {string[]}
 */
function getAskLunaAiAllowedIntents() {
  return INTENT_KEYS.filter((key) => {
    const entry = getEntry(key);
    return entry && entry.readOnly === true && entry.missingHelper !== true;
  });
}

function buildClassifierSystemPrompt(allowedIntents) {
  const lines = allowedIntents.map((key) => {
    const entry = getEntry(key);
    const desc = entry && entry.description ? entry.description : '';
    return `- ${key}: ${desc}`;
  });
  return [
    'Classify this staff operations question into one of these allowed intent keys.',
    'Return JSON only with exactly these keys: intent (string or null), confidence (number 0-1), reason (short string).',
    'Do not answer the question. Do not generate SQL. Do not call tools.',
    'Use null for intent if unsure.',
    '',
    'Allowed intents:',
    ...lines,
  ].join('\n');
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

/**
 * Parse and validate classifier JSON. Returns null if unsafe or invalid.
 *
 * @param {string} rawText
 * @param {Set<string>} allowedIntents
 * @param {{ minConfidence?: number }} [opts]
 * @returns {{ intent: string, confidence: number, reason: string } | null}
 */
function parseAndValidateClassifierOutput(rawText, allowedIntents, opts = {}) {
  const minConfidence = opts.minConfidence != null ? opts.minConfidence : getConfidenceMin();
  const raw = String(rawText || '').trim();
  if (!raw || SQL_OR_TOOL_RE.test(raw)) return null;

  const jsonText = extractJsonObjectText(raw);
  if (!jsonText || SQL_OR_TOOL_RE.test(jsonText)) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_) {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const intentRaw = parsed.intent;
  if (intentRaw != null && typeof intentRaw !== 'string') return null;

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) return null;

  const reason = parsed.reason != null ? String(parsed.reason) : '';
  if (SQL_OR_TOOL_RE.test(reason)) return null;

  if (intentRaw == null || intentRaw === '' || intentRaw === 'null') return null;

  const intent = String(intentRaw).trim();
  if (!allowedIntents.has(intent)) return null;
  if (SQL_OR_TOOL_RE.test(intent)) return null;

  const entry = getEntry(intent);
  if (!entry || entry.readOnly !== true || entry.missingHelper === true) return null;

  return {
    intent,
    confidence: Math.min(1, Math.max(0, confidence)),
    reason: reason.slice(0, 300),
  };
}

async function defaultClassifierProvider(question, allowedIntentList) {
  const system = buildClassifierSystemPrompt(allowedIntentList);
  const content = await callLunaAiJsonChat({
    env: process.env,
    system,
    user: String(question || ''),
    maxTokens: 256,
    temperature: 0,
    jsonObject: true,
  });
  if (content == null) return null;
  return content;
}

/**
 * Classify staff question via AI (registry intents only).
 *
 * @param {string} question
 * @param {{ provider?: Function, allowedIntents?: string[], minConfidence?: number }} [opts]
 * @returns {Promise<{ intent: string, confidence: number, reason: string } | null>}
 */
async function classifyAskLunaIntentWithAi(question, opts = {}) {
  if (!isAskLunaAiEnabled()) return null;

  const allowedList = opts.allowedIntents || getAskLunaAiAllowedIntents();
  const allowedSet = new Set(allowedList);
  if (allowedSet.size === 0) return null;

  const providerFn = opts.provider || defaultClassifierProvider;
  let rawText;
  try {
    rawText = await providerFn(question, allowedList);
  } catch (err) {
    console.warn('[ask-luna-ai] classifier provider error:', err.message);
    return null;
  }

  if (rawText == null || rawText === '') return null;

  return parseAndValidateClassifierOutput(rawText, allowedSet, {
    minConfidence: opts.minConfidence,
  });
}

module.exports = {
  isAskLunaAiEnabled,
  getConfidenceMin,
  getAskLunaAiAllowedIntents,
  buildClassifierSystemPrompt,
  extractJsonObjectText,
  parseAndValidateClassifierOutput,
  classifyAskLunaIntentWithAi,
  SQL_OR_TOOL_RE,
  DEFAULT_CONFIDENCE_MIN,
};
