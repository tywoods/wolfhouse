'use strict';

/**
 * Stage 45b — Luna open phone testing (inbound only).
 *
 * LUNA_OPEN_PHONE_TESTING=true allows unknown guest handsets on wolfhouse-somo WhatsApp
 * inbound when OPEN_DEMO_WHATSAPP_ENABLED is also on. Default off.
 *
 * Does NOT enable live outbound sends, Stripe, booking writes, or n8n activation.
 */

const {
  isConfirmationLiveSendRecipientAllowlisted,
  normalizeRecipientPhone,
} = require('./luna-guest-confirmation-live-send-allowlist');
const { isAllowlistedProofPhone } = require('./luna-live-proof-hygiene');

const OPEN_PHONE_TESTING_ENV = 'LUNA_OPEN_PHONE_TESTING';
const BYPASS_STAFF_ROUTING_ENV = 'LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING';
const STAFF_ROUTING_KEEP_ALLOWLIST_ENV = 'LUNA_OPEN_PHONE_TESTING_STAFF_ROUTING_KEEP_ALLOWLIST';
const WOLFHOUSE_CLIENT_SLUG = 'wolfhouse-somo';

function trimEnv(v) {
  if (v == null) return '';
  return String(v).trim();
}

function readEnv(env) {
  return env || process.env;
}

function isProductionEnvironment(env) {
  return String(readEnv(env).NODE_ENV || '').toLowerCase() === 'production';
}

function isLunaOpenPhoneTestingEnabled(env) {
  return trimEnv(readEnv(env)[OPEN_PHONE_TESTING_ENV]).toLowerCase() === 'true';
}

function isLunaOpenPhoneTestingBypassStaffRoutingEnabled(env) {
  const e = readEnv(env);
  return isLunaOpenPhoneTestingEnabled(e)
    && trimEnv(e[BYPASS_STAFF_ROUTING_ENV]).toLowerCase() === 'true';
}

/**
 * Parse comma/semicolon/whitespace-separated monitor keep-list from env.
 * @param {object} [env]
 * @returns {string[]} normalized digit-only phone numbers
 */
function parseStaffRoutingKeepAllowlist(env) {
  const raw = trimEnv(readEnv(env)[STAFF_ROUTING_KEEP_ALLOWLIST_ENV]);
  if (!raw) return [];
  return [...new Set(
    raw.split(/[,;\s]+/)
      .map(normalizeRecipientPhone)
      .filter(Boolean),
  )];
}

function isStaffRoutingKeepMonitorPhone(phone, env) {
  const normalized = normalizeRecipientPhone(phone);
  if (!normalized) return false;
  const list = parseStaffRoutingKeepAllowlist(env);
  if (!list.length) return false;
  return list.includes(normalized);
}

function extractGuestPhone(body) {
  const b = body || {};
  const raw = b.guest_phone != null ? trimEnv(b.guest_phone)
    : (b.from != null ? trimEnv(b.from) : '');
  if (!raw) return null;
  const digits = normalizeRecipientPhone(raw);
  return digits ? `+${digits}` : null;
}

function extractClientSlug(body) {
  const b = body || {};
  return b.client_slug != null ? trimEnv(b.client_slug) : '';
}

function isKnownInboundTestPhone(guestPhone, env) {
  if (isAllowlistedProofPhone(guestPhone)) return true;
  return isConfirmationLiveSendRecipientAllowlisted(guestPhone, env);
}

function resolveGuestTesterClass(openPhoneTesting, knownTestPhone) {
  if (openPhoneTesting) return 'external_open_testing';
  if (knownTestPhone) return 'allowlisted_test';
  return 'unverified_blocked';
}

/**
 * Inbound-only guest phone gate for wolfhouse-somo open demo / Meta WhatsApp.
 *
 * @returns {{
 *   ok: boolean,
 *   applies?: boolean,
 *   status?: number,
 *   code?: string,
 *   error?: string,
 *   open_phone_testing?: boolean,
 *   guest_tester_class?: string|null,
 *   skipped?: boolean,
 * }}
 */
function evaluateGuestInboundPhoneGate(body, env) {
  if (isProductionEnvironment(env)) {
    return {
      ok: false,
      applies: true,
      status: 403,
      code: 'production_blocked',
      error: 'guest inbound phone testing is disabled in production',
      open_phone_testing: false,
      guest_tester_class: null,
    };
  }

  const clientSlug = extractClientSlug(body);
  if (clientSlug !== WOLFHOUSE_CLIENT_SLUG) {
    return {
      ok: true,
      applies: false,
      skipped: true,
      open_phone_testing: false,
      guest_tester_class: null,
    };
  }

  const guestPhone = extractGuestPhone(body);
  if (!guestPhone) {
    return {
      ok: true,
      applies: false,
      skipped: true,
      open_phone_testing: isLunaOpenPhoneTestingEnabled(env),
      guest_tester_class: null,
    };
  }

  const openPhoneTesting = isLunaOpenPhoneTestingEnabled(env);
  const knownTestPhone = isKnownInboundTestPhone(guestPhone, env);
  const guestTesterClass = resolveGuestTesterClass(openPhoneTesting, knownTestPhone);

  if (openPhoneTesting || knownTestPhone) {
    return {
      ok: true,
      applies: true,
      open_phone_testing: openPhoneTesting,
      guest_tester_class: guestTesterClass,
    };
  }

  return {
    ok: false,
    applies: true,
    status: 403,
    code: 'guest_phone_not_allowlisted',
    error: 'inbound guest phone not allowlisted (set LUNA_OPEN_PHONE_TESTING=true for friend testing)',
    open_phone_testing: false,
    guest_tester_class: guestTesterClass,
  };
}

/**
 * When open demo is enabled but phone gate blocks, Meta must not fall through to legacy draft.
 */
function shouldBlockMetaGuestInboundAfterOpenDemo(env, normalized) {
  const e = readEnv(env);
  if (e.OPEN_DEMO_WHATSAPP_ENABLED !== 'true') {
    return { block: false };
  }
  const digits = String((normalized && normalized.from) || '').replace(/\D/g, '');
  const body = {
    client_slug: trimStr(normalized && normalized.client_slug),
    guest_phone: digits ? `+${digits}` : null,
    phone_number_id: normalized && normalized.phone_number_id != null
      ? trimEnv(normalized.phone_number_id)
      : null,
  };
  const gate = evaluateGuestInboundPhoneGate(body, env);
  if (!gate.applies || gate.ok) {
    return { block: false, gate };
  }
  return { block: true, gate };
}

/**
 * Whether an active staff_phone_access row should route to owner command center (Meta inbound).
 * Default: staff/admin phones stay on owner path. When open phone testing + bypass are on
 * (wolfhouse-somo, non-production), staff phones continue to guest open-demo instead.
 *
 * @param {object} env
 * @param {{ client_slug?: string, phone?: string }} normalized
 * @param {{ found?: boolean, active?: boolean }} staffPhoneAccess
 * @returns {{
 *   route_to_owner: boolean,
 *   bypass_to_guest_path?: boolean,
 *   staff_routing_bypassed?: boolean,
 *   kept_as_staff_monitor?: boolean,
 *   guest_tester_class?: string|null,
 * }}
 */
function evaluateOpenPhoneTestingStaffRoutingBypass(env, normalized, staffPhoneAccess) {
  const access = staffPhoneAccess || {};
  if (!access.found || !access.active) {
    return { route_to_owner: false };
  }

  const clientSlug = trimStr(normalized && normalized.client_slug);
  if (clientSlug !== WOLFHOUSE_CLIENT_SLUG) {
    return { route_to_owner: true };
  }

  if (isProductionEnvironment(env)) {
    return { route_to_owner: true };
  }

  if (!isLunaOpenPhoneTestingBypassStaffRoutingEnabled(env)) {
    return { route_to_owner: true };
  }

  const phone = normalized && normalized.phone != null
    ? normalized.phone
    : (normalized && normalized.from);
  if (isStaffRoutingKeepMonitorPhone(phone, env)) {
    return {
      route_to_owner: true,
      kept_as_staff_monitor: true,
    };
  }

  return {
    route_to_owner: false,
    bypass_to_guest_path: true,
    staff_routing_bypassed: true,
    guest_tester_class: 'staff_open_testing',
  };
}

function shouldRouteActiveStaffPhoneToOwnerCommandCenter(env, normalized, staffPhoneAccess) {
  return evaluateOpenPhoneTestingStaffRoutingBypass(env, normalized, staffPhoneAccess)
    .route_to_owner === true;
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function buildMetaGuestPhoneGateBlockedExtras(gate) {
  const g = gate || {};
  return {
    success: false,
    guest_phone_gate_blocked: true,
    guest_phone_gate_code: g.code || 'guest_phone_not_allowlisted',
    guest_phone_gate_error: g.error || null,
    open_phone_testing: g.open_phone_testing === true,
    guest_tester_class: g.guest_tester_class || 'unverified_blocked',
    dry_run: true,
    sends_whatsapp: false,
    live_send_blocked: true,
    draft_called: false,
    send_attempted: false,
    preview_only: true,
    no_write_performed: true,
  };
}

function buildOpenDemoPhoneGateBlockedResponse(gate) {
  const g = gate || {};
  return {
    success: false,
    dry_run: true,
    open_demo: true,
    sends_whatsapp: false,
    live_send_blocked: true,
    demo_gate_blocked: true,
    demo_gate_code: g.code || 'guest_phone_not_allowlisted',
    error: g.error || 'inbound guest phone not allowlisted',
    open_phone_testing: g.open_phone_testing === true,
    guest_tester_class: g.guest_tester_class || 'unverified_blocked',
  };
}

module.exports = {
  OPEN_PHONE_TESTING_ENV,
  BYPASS_STAFF_ROUTING_ENV,
  STAFF_ROUTING_KEEP_ALLOWLIST_ENV,
  WOLFHOUSE_CLIENT_SLUG,
  isLunaOpenPhoneTestingEnabled,
  isLunaOpenPhoneTestingBypassStaffRoutingEnabled,
  parseStaffRoutingKeepAllowlist,
  isStaffRoutingKeepMonitorPhone,
  isKnownInboundTestPhone,
  evaluateGuestInboundPhoneGate,
  evaluateOpenPhoneTestingStaffRoutingBypass,
  shouldRouteActiveStaffPhoneToOwnerCommandCenter,
  shouldBlockMetaGuestInboundAfterOpenDemo,
  buildMetaGuestPhoneGateBlockedExtras,
  buildOpenDemoPhoneGateBlockedResponse,
};
