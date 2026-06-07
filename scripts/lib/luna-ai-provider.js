/**
 * Phase 24a — Shared Luna AI provider (OpenAI + Anthropic).
 *
 * Used by Staff Ask Luna classifiers/formatters. No guest WhatsApp path.
 *
 * @module luna-ai-provider
 */

'use strict';

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function readEnv(env, ...keys) {
  const e = env || {};
  for (const key of keys) {
    if (key == null) continue;
    const v = e[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * Resolve provider, model, and API key from env (no network).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: boolean, provider: 'openai'|'anthropic'|null, model: string|null, apiKey: string|null }}
 */
function resolveLunaAiProvider(env = process.env) {
  const openaiKey = readEnv(env, 'OPENAI_API_KEY', 'STAFF_ASK_LUNA_OPENAI_API_KEY');
  const anthropicKey = readEnv(env, 'ANTHROPIC_API_KEY', 'STAFF_ASK_LUNA_ANTHROPIC_API_KEY');
  let provider = readEnv(env, 'LUNA_AI_PROVIDER', 'STAFF_ASK_LUNA_AI_PROVIDER').toLowerCase();

  if (!provider) {
    if (openaiKey) provider = 'openai';
    else if (anthropicKey) provider = 'anthropic';
  }

  if (provider === 'openai') {
    if (!openaiKey) {
      return { enabled: false, provider: null, model: null, apiKey: null };
    }
    const model = resolveLunaAiModel(env, 'openai');
    return { enabled: true, provider: 'openai', model, apiKey: openaiKey };
  }

  if (provider === 'anthropic') {
    if (!anthropicKey) {
      return { enabled: false, provider: null, model: null, apiKey: null };
    }
    const model = resolveLunaAiModel(env, 'anthropic');
    return { enabled: true, provider: 'anthropic', model, apiKey: anthropicKey };
  }

  return { enabled: false, provider: null, model: null, apiKey: null };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {'openai'|'anthropic'} provider
 * @returns {string}
 */
function resolveLunaAiModel(env, provider) {
  const shared = readEnv(env, 'LUNA_AI_MODEL', 'STAFF_ASK_LUNA_AI_MODEL');
  if (shared) return shared;
  if (provider === 'openai') {
    return readEnv(env, 'OPENAI_MODEL') || DEFAULT_OPENAI_MODEL;
  }
  return readEnv(env, 'ANTHROPIC_MODEL') || DEFAULT_ANTHROPIC_MODEL;
}

/**
 * Call configured provider; returns assistant text or null when disabled.
 *
 * @param {{
 *   system: string,
 *   user: string,
 *   env?: NodeJS.ProcessEnv,
 *   maxTokens?: number,
 *   temperature?: number,
 *   jsonObject?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<string|null>}
 */
async function callLunaAiJsonChat(opts = {}) {
  const env = opts.env || process.env;
  const cfg = resolveLunaAiProvider(env);
  if (!cfg.enabled || !cfg.apiKey) return null;

  const fetchImpl = opts.fetchImpl || fetch;
  const temperature = opts.temperature != null ? opts.temperature : 0;
  const maxTokens = opts.maxTokens != null ? opts.maxTokens : 256;
  const system = String(opts.system || '');
  const user = String(opts.user || '');

  if (cfg.provider === 'openai') {
    const body = {
      model: cfg.model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (opts.jsonObject) {
      body.response_format = { type: 'json_object' };
    }
    const res = await fetchImpl(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return content != null ? String(content) : '';
  }

  if (cfg.provider === 'anthropic') {
    const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const block = (data?.content || []).find((b) => b.type === 'text');
    return block && block.text != null ? String(block.text) : '';
  }

  return null;
}

module.exports = {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  OPENAI_CHAT_URL,
  ANTHROPIC_MESSAGES_URL,
  resolveLunaAiProvider,
  resolveLunaAiModel,
  callLunaAiJsonChat,
};
