/**
 * Phase 11a.2 — Staff Ask Luna AI intent classifier (registry-only).
 *
 * Classifies staff questions into existing read-only registry intent keys only.
 * Does not generate SQL, answers, or use conversation/chat logs.
 *
 * Enable: STAFF_ASK_LUNA_AI_ENABLED=true plus OPENAI_API_KEY or ANTHROPIC_API_KEY.
 * Default: disabled (deterministic routing only).
 *
 * @module staff-ask-luna-ai-intent
 */

'use strict';

const { getEntry, INTENT_KEYS } = require('./staff-query-registry');

const DEFAULT_CONFIDENCE_MIN = 0.75;
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022';

const SQL_OR_TOOL_RE = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b|```|`{3,}|tool_use|tool_call|"tool"\s*:|function_call/i;

function isAskLunaAiEnabled() {
  const v = String(process.env.STAFF_ASK_LUNA_AI_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
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

async function callOpenAiClassifier(question, allowedIntents, apiKey) {
  const model = process.env.STAFF_ASK_LUNA_AI_MODEL || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const system = buildClassifierSystemPrompt(allowedIntents);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: String(question || '') },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI classifier HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return content != null ? String(content) : '';
}

async function callAnthropicClassifier(question, allowedIntents, apiKey) {
  const model = process.env.STAFF_ASK_LUNA_AI_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const system = buildClassifierSystemPrompt(allowedIntents);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: String(question || '') }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic classifier HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const block = (data?.content || []).find((b) => b.type === 'text');
  return block && block.text != null ? String(block.text) : '';
}

async function defaultClassifierProvider(question, allowedIntentList) {
  const openaiKey = process.env.OPENAI_API_KEY || process.env.STAFF_ASK_LUNA_OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.STAFF_ASK_LUNA_ANTHROPIC_API_KEY;
  const provider = String(process.env.STAFF_ASK_LUNA_AI_PROVIDER || '').trim().toLowerCase();

  if (provider === 'anthropic' || (!provider && anthropicKey && !openaiKey)) {
    if (!anthropicKey) return null;
    return callAnthropicClassifier(question, allowedIntentList, anthropicKey);
  }
  if (openaiKey) {
    return callOpenAiClassifier(question, allowedIntentList, openaiKey);
  }
  if (anthropicKey) {
    return callAnthropicClassifier(question, allowedIntentList, anthropicKey);
  }
  return null;
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

  const provider = opts.provider || defaultClassifierProvider;
  let rawText;
  try {
    rawText = await provider(question, allowedList);
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
