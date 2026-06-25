/**
 * Phase 24a/24d — Shared Luna AI provider (OpenAI + Anthropic).
 *
 * Used by Staff Ask Luna classifiers/formatters. No guest WhatsApp path.
 *
 * @module luna-ai-provider
 */

'use strict';

const crypto = require('crypto');

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function readTrimmedEnvValue(env, key) {
  if (!env || key == null) return '';
  const v = env[key];
  if (v == null) return '';
  return String(v).trim();
}

/**
 * First non-empty trimmed env value wins; records which key supplied it.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} keys
 * @returns {{ value: string, source: string|null }}
 */
function readEnvFirst(env, keys) {
  for (const key of keys) {
    if (key == null) continue;
    const value = readTrimmedEnvValue(env, key);
    if (value !== '') return { value, source: key };
  }
  return { value: '', source: null };
}

function hashKeyFingerprint(apiKey) {
  if (!apiKey) return null;
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 8);
}

function buildKeyDiagnostics(apiKey, keySource) {
  return {
    key_present: !!apiKey,
    key_source: keySource,
    key_length: apiKey ? apiKey.length : 0,
    key_fingerprint: hashKeyFingerprint(apiKey),
  };
}

function resolveOpenAiApiKey(env) {
  return readEnvFirst(env, ['OPENAI_API_KEY', 'STAFF_ASK_LUNA_OPENAI_API_KEY']);
}

function resolveAnthropicApiKey(env) {
  return readEnvFirst(env, ['ANTHROPIC_API_KEY', 'STAFF_ASK_LUNA_ANTHROPIC_API_KEY']);
}

function resolveProviderSelection(env) {
  const explicit = readEnvFirst(env, ['LUNA_AI_PROVIDER', 'STAFF_ASK_LUNA_AI_PROVIDER']);
  if (explicit.value) {
    return { provider: explicit.value.toLowerCase(), provider_source: explicit.source };
  }
  const openaiKey = resolveOpenAiApiKey(env);
  if (openaiKey.value) {
    return { provider: 'openai', provider_source: 'auto:openai_key' };
  }
  const anthropicKey = resolveAnthropicApiKey(env);
  if (anthropicKey.value) {
    return { provider: 'anthropic', provider_source: 'auto:anthropic_key' };
  }
  return { provider: '', provider_source: null };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {'openai'|'anthropic'} provider
 * @returns {{ model: string, model_source: string|null }}
 */
function resolveModelSelection(env, provider) {
  const shared = readEnvFirst(env, ['LUNA_AI_MODEL', 'STAFF_ASK_LUNA_AI_MODEL']);
  if (shared.value) return { model: shared.value, model_source: shared.source };

  if (provider === 'openai') {
    const fallback = readEnvFirst(env, ['OPENAI_MODEL']);
    if (fallback.value) return { model: fallback.value, model_source: fallback.source };
    return { model: DEFAULT_OPENAI_MODEL, model_source: 'default' };
  }

  const fallback = readEnvFirst(env, ['ANTHROPIC_MODEL']);
  if (fallback.value) return { model: fallback.value, model_source: fallback.source };
  return { model: DEFAULT_ANTHROPIC_MODEL, model_source: 'default' };
}

/**
 * Safe diagnostic metadata (no secrets).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   enabled: boolean,
 *   provider: 'openai'|'anthropic'|null,
 *   model: string|null,
 *   provider_source: string|null,
 *   model_source: string|null,
 *   key_present: boolean,
 *   key_source: string|null,
 *   key_length: number,
 *   key_fingerprint: string|null,
 * }}
 */
function resolveLunaAiDiagnostics(env = process.env) {
  const cfg = resolveLunaAiProvider(env);
  const keyMeta = cfg.provider === 'openai'
    ? buildKeyDiagnostics(resolveOpenAiApiKey(env).value, cfg.key_source)
    : cfg.provider === 'anthropic'
      ? buildKeyDiagnostics(resolveAnthropicApiKey(env).value, cfg.key_source)
      : buildKeyDiagnostics(null, null);

  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    model: cfg.model,
    provider_source: cfg.provider_source,
    model_source: cfg.model_source,
    ...keyMeta,
  };
}

/**
 * Safe public health summary (no key length, no secrets).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   configured: boolean,
 *   provider: 'openai'|'anthropic'|null,
 *   model: string|null,
 *   key_present: boolean,
 *   key_source: string|null,
 *   key_fingerprint: string|null,
 * }}
 */
function resolveLunaAiHealthSummary(env = process.env) {
  const diag = resolveLunaAiDiagnostics(env);
  return {
    configured: diag.enabled,
    provider: diag.provider,
    model: diag.model,
    key_present: diag.key_present,
    key_source: diag.key_source,
    key_fingerprint: diag.key_fingerprint,
  };
}

/**
 * Resolve provider, model, and API key from env (no network).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   enabled: boolean,
 *   provider: 'openai'|'anthropic'|null,
 *   model: string|null,
 *   apiKey: string|null,
 *   provider_source: string|null,
 *   model_source: string|null,
 *   key_source: string|null,
 *   key_length: number,
 *   key_fingerprint: string|null,
 * }}
 */
function resolveLunaAiProvider(env = process.env) {
  const { provider, provider_source } = resolveProviderSelection(env);
  const openaiKey = resolveOpenAiApiKey(env);
  const anthropicKey = resolveAnthropicApiKey(env);

  if (provider === 'openai') {
    if (!openaiKey.value) {
      return {
        enabled: false,
        provider: null,
        model: null,
        apiKey: null,
        provider_source,
        model_source: null,
        key_source: null,
        key_length: 0,
        key_fingerprint: null,
        key_present: false,
      };
    }
    const { model, model_source } = resolveModelSelection(env, 'openai');
    const keyMeta = buildKeyDiagnostics(openaiKey.value, openaiKey.source);
    return {
      enabled: true,
      provider: 'openai',
      model,
      apiKey: openaiKey.value,
      provider_source,
      model_source,
      ...keyMeta,
    };
  }

  if (provider === 'anthropic') {
    if (!anthropicKey.value) {
      return {
        enabled: false,
        provider: null,
        model: null,
        apiKey: null,
        provider_source,
        model_source: null,
        key_source: null,
        key_length: 0,
        key_fingerprint: null,
        key_present: false,
      };
    }
    const { model, model_source } = resolveModelSelection(env, 'anthropic');
    const keyMeta = buildKeyDiagnostics(anthropicKey.value, anthropicKey.source);
    return {
      enabled: true,
      provider: 'anthropic',
      model,
      apiKey: anthropicKey.value,
      provider_source,
      model_source,
      ...keyMeta,
    };
  }

  return {
    enabled: false,
    provider: null,
    model: null,
    apiKey: null,
    provider_source: provider_source || null,
    model_source: null,
    key_source: null,
    key_length: 0,
    key_fingerprint: null,
    key_present: false,
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {'openai'|'anthropic'} provider
 * @returns {string}
 */
function resolveLunaAiModel(env, provider) {
  return resolveModelSelection(env, provider).model;
}

function safeErrorSnippet(text, maxLen = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.slice(0, maxLen);
}

function parseProviderErrorBody(provider, errText) {
  try {
    const parsed = JSON.parse(errText);
    if (provider === 'openai' && parsed && parsed.error) {
      return {
        error_type: parsed.error.type ? String(parsed.error.type) : null,
        error_message: safeErrorSnippet(parsed.error.message),
      };
    }
    if (provider === 'anthropic' && parsed && parsed.error) {
      return {
        error_type: parsed.error.type ? String(parsed.error.type) : null,
        error_message: safeErrorSnippet(parsed.error.message),
      };
    }
  } catch (_) {
    /* non-JSON body */
  }
  return {
    error_type: null,
    error_message: safeErrorSnippet(errText),
  };
}

function buildLunaAiHttpError(providerLabel, status, cfg, callLabel, errText) {
  const parsed = parseProviderErrorBody(cfg.provider, errText);
  const details = {
    status,
    provider: cfg.provider,
    model: cfg.model,
    call_label: callLabel || null,
    key_source: cfg.key_source || null,
    key_fingerprint: cfg.key_fingerprint || null,
    error_type: parsed.error_type,
    error_message: parsed.error_message,
  };

  const parts = [
    `${providerLabel} HTTP ${status}`,
    callLabel ? `call_label=${callLabel}` : null,
    cfg.provider ? `provider=${cfg.provider}` : null,
    cfg.model ? `model=${cfg.model}` : null,
    parsed.error_type ? `type=${parsed.error_type}` : null,
    parsed.error_message ? `message=${parsed.error_message}` : null,
    cfg.key_source ? `key_source=${cfg.key_source}` : null,
    cfg.key_fingerprint ? `key_fingerprint=${cfg.key_fingerprint}` : null,
  ].filter(Boolean);

  const err = new Error(parts.join(' '));
  err.name = 'LunaAiHttpError';
  err.lunaAi = details;
  return err;
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
 *   call_label?: string,
 * }} opts
 * @returns {Promise<string|null>}
 */
async function callLunaAiJsonChat(opts = {}) {
  const env = opts.env || process.env;
  const cfg = resolveLunaAiProvider(env);
  if (!cfg.enabled || !cfg.apiKey) return null;

  const fetchImpl = opts.fetchImpl || fetch;
  // temperature: pass a number to set it; pass null to OMIT it entirely (some models,
  // e.g. GPT-5.x, only accept the default temperature and 400 on an explicit 0).
  const includeTemperature = opts.temperature !== null;
  const temperature = opts.temperature != null ? opts.temperature : 0;
  const maxTokens = opts.maxTokens != null ? opts.maxTokens : 256;
  const system = String(opts.system || '');
  const user = String(opts.user || '');
  const callLabel = opts.call_label ? String(opts.call_label) : null;
  // Optional per-call model override (e.g. a stronger model for owner NL->SQL)
  // without changing the runtime-wide LUNA_AI_MODEL. Falls back to the configured model.
  const model = opts.model ? String(opts.model).trim() : cfg.model;

  if (cfg.provider === 'openai') {
    const body = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (includeTemperature) body.temperature = temperature;
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
      throw buildLunaAiHttpError('OpenAI', res.status, cfg, callLabel, errText);
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
        model,
        max_tokens: maxTokens,
        ...(includeTemperature ? { temperature } : {}),
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw buildLunaAiHttpError('Anthropic', res.status, cfg, callLabel, errText);
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
  hashKeyFingerprint,
  resolveLunaAiProvider,
  resolveLunaAiDiagnostics,
  resolveLunaAiHealthSummary,
  resolveLunaAiModel,
  callLunaAiJsonChat,
  buildLunaAiHttpError,
};
