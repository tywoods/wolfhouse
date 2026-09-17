'use strict';

/**
 * Crowsnest Live Simulator server-side proxy.
 *
 * Operators choose tenant + guest phone in Crowsnest; this module keeps the
 * tenant runtime URL/token server-side and always calls the staging simulator in
 * no-write/no-send mode. Conversation continuity is provided by the tenant Luna
 * runtime: the caller-chosen phone is forwarded as the simulator thread/guest
 * phone, and each tenant runtime has its own session store.
 */

const DEFAULT_TIMEOUT_MS = 185 * 1000;
const MAX_TEXT_CHARS = 4000;
const MAX_LANG_CHARS = 16;

const LIVE_SIMULATOR_ROUTE = '/api/live-simulator/guest-turn';
const TENANT_SIMULATE_PATH = '/wolfhouse/simulate-guest-turn';
const ALLOWED_HOSTS_ENV = 'CROWSNEST_LIVE_SIM_ALLOWED_HOSTS';
const SUNSET_BOOKING_ONLY_MODE = 'sunset_booking_only';

const WRITE_DENY_LIST = Object.freeze([
  'create_booking_from_plan',
  'create_payment_link',
  'create_balance_payment_link',
  'create_guest_payment_link',
  'add_service_to_booking',
  'add_catalog_service_to_booking',
  'save_transfer_request',
  'update_booking_contact',
  'update_guest_packages',
  'flag_needs_human',
  'send_whatsapp_message',
  'send_sms',
]);

const TENANTS = Object.freeze({
  wolfhouse: Object.freeze({
    id: 'wolfhouse',
    label: 'Wolfhouse Luna',
    runtime: 'wolfhouse',
    defaultOrigin: 'http://127.0.0.1:8090',
    envOrigin: 'CROWSNEST_LIVE_SIM_WOLFHOUSE_ORIGIN',
    envToken: 'CROWSNEST_LIVE_SIM_WOLFHOUSE_TOKEN',
    fallbackTokenEnv: 'LUNA_BOT_INTERNAL_TOKEN',
  }),
  sunset: Object.freeze({
    id: 'sunset',
    label: 'Sunset Luna',
    runtime: 'sunset',
    defaultOrigin: 'http://127.0.0.1:8094',
    envOrigin: 'CROWSNEST_LIVE_SIM_SUNSET_ORIGIN',
    envToken: 'CROWSNEST_LIVE_SIM_SUNSET_TOKEN',
    fallbackTokenEnv: 'LUNA_BOT_INTERNAL_TOKEN_SUNSET',
  }),
});

function normalizeTenant(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'wolfhouse' || raw === 'wolfhouse-somo' || raw === 'somo') return 'wolfhouse';
  if (raw === 'sunset' || raw === 'sunset-luna' || raw === 'sunset-somo') return 'sunset';
  return '';
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits || digits.length < 10 || digits.length > 15) {
    return { ok: false, error: 'from_phone must contain 10–15 digits' };
  }
  return {
    ok: true,
    input: raw,
    digits,
    e164: `+${digits}`,
  };
}

function sanitizeLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/[^a-z0-9_-]/g, '').slice(0, MAX_LANG_CHARS);
}

function parseJsonBody(raw) {
  try {
    return { ok: true, body: JSON.parse(String(raw || '')) };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

function normalizeAllowedHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function parseAllowedHosts(value) {
  return String(value || '')
    .split(',')
    .map(normalizeAllowedHost)
    .filter(Boolean);
}

function originHostname(origin) {
  try {
    return normalizeAllowedHost(new URL(origin).hostname);
  } catch {
    return '';
  }
}

function runtimeOriginAllowed(origin, options = {}) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  const env = options.env || process.env;
  const allowedHosts = new Set([
    '127.0.0.1',
    'localhost',
    '::1',
    ...parseAllowedHosts(env[ALLOWED_HOSTS_ENV]),
    ...(Array.isArray(options.trustedOriginHosts) ? options.trustedOriginHosts.map(normalizeAllowedHost) : []),
  ].filter(Boolean));
  return (
    (url.protocol === 'http:' || url.protocol === 'https:')
    && allowedHosts.has(normalizeAllowedHost(hostname))
  );
}

function resolveTenantRuntime(tenantId, env = process.env) {
  const tenant = TENANTS[tenantId];
  if (!tenant) return null;
  const explicitOrigin = String(env[tenant.envOrigin] || '').trim();
  const origin = String(explicitOrigin || tenant.defaultOrigin || '').trim().replace(/\/+$/, '');
  const fallbackToken = tenant.fallbackTokenEnv ? env[tenant.fallbackTokenEnv] : '';
  const token = String(env[tenant.envToken] || fallbackToken || '').trim();
  const trustedOriginHosts = explicitOrigin ? [originHostname(origin)] : [];
  return {
    ...tenant,
    origin,
    url: `${origin}${TENANT_SIMULATE_PATH}`,
    token,
    origin_allowed: runtimeOriginAllowed(origin, { env, trustedOriginHosts }),
  };
}

function buildTenantRequest({ tenantId, fromPhone, text, lang }, env = process.env) {
  const tenant = normalizeTenant(tenantId);
  if (!tenant) {
    return { ok: false, status: 400, code: 'invalid_tenant', error: 'tenant must be wolfhouse or sunset' };
  }
  const runtime = resolveTenantRuntime(tenant, env);
  if (!runtime || !runtime.origin_allowed) {
    return { ok: false, status: 503, code: 'runtime_not_safely_scoped', error: 'live simulator runtime is not safely scoped to localhost' };
  }

  const phone = normalizePhone(fromPhone);
  if (!phone.ok) {
    return { ok: false, status: 400, code: 'invalid_from_phone', error: phone.error };
  }

  const messageText = String(text || '').trim();
  if (!messageText) {
    return { ok: false, status: 400, code: 'missing_text', error: 'text is required' };
  }
  if (messageText.length > MAX_TEXT_CHARS) {
    return { ok: false, status: 413, code: 'text_too_large', error: `text must be ${MAX_TEXT_CHARS} characters or fewer` };
  }

  const payload = {
    thread: phone.e164,
    guest_phone: phone.e164,
    text: messageText,
    message_text: messageText,
    allow_writes: false,
  };
  const bookingOnlyMode = tenant === 'sunset';
  if (bookingOnlyMode) payload.simulator_write_mode = SUNSET_BOOKING_ONLY_MODE;
  const safeLang = sanitizeLang(lang);
  if (safeLang) payload.lang = safeLang;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (runtime.token) headers['X-Luna-Bot-Token'] = runtime.token;

  return {
    ok: true,
    tenant,
    runtime,
    phone,
    payload,
    headers,
    limitation: buildLiveSimulatorLimitation({ bookingOnlyMode: tenant === 'sunset' }),
  };
}

function buildLiveSimulatorLimitation(options = {}) {
  const bookingOnlyMode = options.bookingOnlyMode === true;
  return {
    staging_only: true,
    writes_enabled: false,
    booking_writes_enabled: bookingOnlyMode,
    booking_write_mode: bookingOnlyMode ? SUNSET_BOOKING_ONLY_MODE : null,
    whatsapp_sends_enabled: false,
    sms_sends_enabled: false,
    payments_enabled: false,
    waiver_creation_enabled: false,
    limitation_flag: bookingOnlyMode ? 'sunset_booking_only_writes_enabled' : 'writes_and_external_sends_disabled',
    denied_actions: WRITE_DENY_LIST.slice(),
  };
}

async function postTenantSimulator({ url, headers, payload, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const fetchFn = fetchImpl || global.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, status: 503, code: 'fetch_unavailable', error: 'fetch is unavailable in this runtime' };
  }

  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac ? ac.signal : undefined,
    });
    const text = await resp.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 2048) };
    }
    return {
      ok: resp.ok,
      status: resp.status,
      body,
    };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return {
      ok: false,
      status: aborted ? 504 : 502,
      code: aborted ? 'runtime_timeout' : 'runtime_unreachable',
      error: aborted ? 'tenant simulator timed out' : 'tenant simulator is unreachable',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redactRuntime(runtime) {
  return {
    tenant: runtime.id,
    label: runtime.label,
    target_path: TENANT_SIMULATE_PATH,
    declared_port: Number(new URL(runtime.origin).port || (runtime.origin.startsWith('https:') ? 443 : 80)),
    origin_host: new URL(runtime.origin).hostname,
  };
}

function shapeSimulatorResponse({ request, upstream }) {
  const body = upstream.body && typeof upstream.body === 'object' ? upstream.body : {};
  const warnings = Array.isArray(body.warnings) ? body.warnings.slice() : [];
  const toolCalls = Array.isArray(body.tool_calls) ? body.tool_calls : [];
  const blockedWrites = toolCalls
    .filter((call) => call && call.result_summary && call.result_summary.simulate_write_blocked)
    .map((call) => call.name)
    .filter(Boolean);

  return {
    ok: upstream.ok && body.ok !== false,
    tenant: request.tenant,
    tenant_label: request.runtime.label,
    from_phone: request.phone.e164,
    guest_phone: body.guest_phone || request.phone.e164,
    memory_scope: `${request.tenant}:${request.phone.e164}`,
    reply_text: body.reply_text || '',
    raw_reply_text: body.raw_reply_text,
    session_id: body.session_id || null,
    language_detected: body.language_detected || null,
    tool_calls: toolCalls,
    guard_findings: body.guard_findings || [],
    warnings,
    upstream_status: upstream.status,
    upstream_ok: body.ok !== false,
    runtime: redactRuntime(request.runtime),
    limitation: {
      ...request.limitation,
      tenant_whatsapp_suppressed: body.whatsapp_suppressed === true,
      tenant_allow_writes: body.allow_writes === true,
      blocked_write_tools: blockedWrites,
    },
  };
}

async function runLiveSimulatorTurn(input, options = {}) {
  const built = buildTenantRequest(input, options.env || process.env);
  if (!built.ok) return built;

  const upstream = await postTenantSimulator({
    url: built.runtime.url,
    headers: built.headers,
    payload: built.payload,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
  });

  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status || 502,
      code: upstream.code || 'tenant_simulator_error',
      error: upstream.error || (upstream.body && upstream.body.error) || 'tenant simulator rejected the turn',
      tenant: built.tenant,
      from_phone: built.phone.e164,
      memory_scope: `${built.tenant}:${built.phone.e164}`,
      runtime: redactRuntime(built.runtime),
      limitation: built.limitation,
      upstream_body: upstream.body,
    };
  }

  const shaped = shapeSimulatorResponse({ request: built, upstream });
  return { ...shaped, status: shaped.ok ? 200 : 502 };
}

module.exports = {
  LIVE_SIMULATOR_ROUTE,
  TENANT_SIMULATE_PATH,
  SUNSET_BOOKING_ONLY_MODE,
  TENANTS,
  WRITE_DENY_LIST,
  buildLiveSimulatorLimitation,
  buildTenantRequest,
  normalizePhone,
  normalizeTenant,
  parseJsonBody,
  postTenantSimulator,
  runtimeOriginAllowed,
  resolveTenantRuntime,
  runLiveSimulatorTurn,
  shapeSimulatorResponse,
};
