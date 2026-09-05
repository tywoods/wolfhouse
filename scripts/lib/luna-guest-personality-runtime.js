'use strict';

/**
 * Luna Personality runtime — resolve the closed WhatsApp ID once per guest
 * turn and inject one server-owned style pack into the authoring seam.
 *
 * Failures/timeouts never block the guest reply (sunny default).
 */

const {
  CHANNEL,
  DEFAULT_PERSONALITY_ID,
  getPersonalityPack,
  normalizeStoredPersonalityId,
  personalityObservability,
} = require('./luna-guest-personality-packs');
const { COMPOSER_OWNED_STATES } = require('./luna-guest-composer-ownership');

const DEFAULT_TIMEOUT_MS = 800;
const CACHE_TTL_MS = 15000;
const CACHE_MAX = 64;
const INJECTION_MARK = 'Luna Personality this turn:';

const CACHE = new Map();

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function cacheKey(tenantId) {
  return trimStr(tenantId) || '_missing_tenant_';
}

function pruneCache(now) {
  if (CACHE.size <= CACHE_MAX) return;
  for (const [key, entry] of CACHE) {
    if (!entry || entry.expiresAt <= now) CACHE.delete(key);
    if (CACHE.size <= CACHE_MAX) return;
  }
  const first = CACHE.keys().next().value;
  if (first) CACHE.delete(first);
}

function shouldFreezePersonalityStyle(composerState) {
  const state = trimStr(composerState);
  return !!(state && COMPOSER_OWNED_STATES.includes(state));
}

function sunnyFallback(tenantId, channel, reason) {
  const pack = getPersonalityPack(DEFAULT_PERSONALITY_ID);
  return {
    applied: channel === CHANNEL,
    pack: channel === CHANNEL ? pack : null,
    observability: personalityObservability({
      tenant_id: tenantId || null,
      channel,
      personality_id: DEFAULT_PERSONALITY_ID,
      source: 'default',
      fallback_reason: reason || null,
    }),
  };
}

function withTimeout(promise, ms) {
  const timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error('setting_timeout');
      err.code = 'setting_timeout';
      reject(err);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function defaultFetchPersonalitySetting(args) {
  const a = args || {};
  const env = a.env || process.env;
  const base = trimStr(env.WOLFHOUSE_STAFF_API_BASE_URL || env.STAFF_API_BASE_URL);
  const token = trimStr(env.LUNA_BOT_INTERNAL_TOKEN);
  if (!base || !token || typeof fetch !== 'function') {
    const err = new Error('setting_unavailable');
    err.code = 'setting_unavailable';
    throw err;
  }
  const res = await fetch(`${base.replace(/\/$/, '')}/staff/bot/luna-personality`, {
    method: 'GET',
    headers: { 'X-Luna-Bot-Token': token, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`setting_http_${res.status}`);
    err.code = 'setting_http';
    throw err;
  }
  return res.json();
}

async function resolveWhatsAppPersonalityOnce(args) {
  const a = args || {};
  const channel = trimStr(a.channel || CHANNEL).toLowerCase() || CHANNEL;
  const tenantId = trimStr(a.tenant_id || a.client_id || a.client_slug);
  if (channel !== CHANNEL) {
    return {
      applied: false,
      pack: null,
      observability: personalityObservability({
        tenant_id: tenantId || null,
        channel,
        personality_id: DEFAULT_PERSONALITY_ID,
        source: 'channel_skipped',
        fallback_reason: 'not_whatsapp',
      }),
    };
  }

  const now = Number.isFinite(a.now) ? a.now : Date.now();
  const key = cacheKey(tenantId);
  const hit = CACHE.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const fetchSetting = a.fetchSetting || defaultFetchPersonalitySetting;
  try {
    const raw = await withTimeout(fetchSetting({
      tenant_id: tenantId,
      channel,
      env: a.env,
    }), a.timeout_ms);
    const stored = raw && (raw.personality_id != null ? raw.personality_id : raw[require('./luna-guest-personality-packs').SETTINGS_KEY]);
    const normalized = normalizeStoredPersonalityId(stored);
    const pack = getPersonalityPack(normalized.id);
    const value = {
      applied: true,
      pack,
      observability: personalityObservability({
        tenant_id: tenantId || null,
        channel,
        personality_id: pack.id,
        source: normalized.source,
        fallback_reason: normalized.source === 'stored' ? null : normalized.source,
      }),
    };
    pruneCache(now);
    CACHE.set(key, { expiresAt: now + CACHE_TTL_MS, value });
    return value;
  } catch (err) {
    const reason = (err && err.code === 'setting_timeout') || (err && err.message === 'setting_timeout')
      ? 'setting_timeout'
      : 'setting_failure';
    const value = sunnyFallback(tenantId, channel, reason);
    pruneCache(now);
    CACHE.set(key, { expiresAt: now + Math.min(CACHE_TTL_MS, 3000), value });
    return value;
  }
}

function injectPersonalityPackOnce(args) {
  const a = args || {};
  const systemPrompt = a.system_prompt == null ? '' : String(a.system_prompt);
  const channel = trimStr(a.channel || CHANNEL).toLowerCase() || CHANNEL;
  const pack = a.pack && a.pack.instruction ? a.pack : null;

  if (a.already_injected === true || systemPrompt.includes(INJECTION_MARK)) {
    return { system_prompt: systemPrompt, injected: false, injection_count: 0 };
  }
  if (channel !== CHANNEL || !pack) {
    return { system_prompt: systemPrompt, injected: false, injection_count: 0 };
  }
  if (shouldFreezePersonalityStyle(a.composer_state)) {
    return { system_prompt: systemPrompt, injected: false, injection_count: 0 };
  }
  const suffix = `\n\n${pack.instruction}`;
  return {
    system_prompt: `${systemPrompt}${suffix}`,
    injected: true,
    injection_count: 1,
  };
}

function clearPersonalityRuntimeCache() {
  CACHE.clear();
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  CACHE_TTL_MS,
  INJECTION_MARK,
  shouldFreezePersonalityStyle,
  resolveWhatsAppPersonalityOnce,
  injectPersonalityPackOnce,
  defaultFetchPersonalitySetting,
  clearPersonalityRuntimeCache,
};
