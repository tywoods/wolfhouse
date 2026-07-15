'use strict';

/**
 * Central no-send / no-write guard for Sunset golden runners.
 *
 * Hard-blocks side effects regardless of fixture flags
 * (allow_writes / whatsapp_suppressed / email_suppressed).
 * Fixture misconfiguration must never open a send/create path.
 */

const BLOCKED_EFFECTS = Object.freeze([
  'booking_create',
  'payment_link_create',
  'stripe_checkout_create',
  'whatsapp_send',
  'email_send',
]);

const BLOCKED_TOOL_NAMES = Object.freeze([
  'create_sunset_booking',
  'create_sunset_payment_link',
  'create_payment_link',
  'send_whatsapp',
  'send_whatsapp_message',
  'send_email',
  'send_confirmation',
]);

const BLOCK_REASON = 'sunset_golden_central_no_send';

function normalizeEffect(effect) {
  return String(effect || '').trim().toLowerCase();
}

function normalizeToolName(name) {
  return String(name || '').trim();
}

function isBlockedEffect(effect) {
  return BLOCKED_EFFECTS.includes(normalizeEffect(effect));
}

function isBlockedToolName(name) {
  const n = normalizeToolName(name);
  if (!n) return false;
  if (BLOCKED_TOOL_NAMES.includes(n)) return true;
  const lower = n.toLowerCase();
  if (lower.startsWith('create_sunset_booking')) return true;
  if (lower.includes('payment_link') && (lower.startsWith('create_') || lower.includes('_create'))) return true;
  if (lower.includes('whatsapp') && lower.includes('send')) return true;
  if (lower.includes('email') && lower.includes('send')) return true;
  return false;
}

/**
 * Evaluate whether a side effect may proceed.
 * Fixture flags are intentionally ignored for blocked effects.
 *
 * @param {string} effect
 * @param {object} [fixture]
 * @returns {{ allowed: boolean, reason: string|null, effect: string, fixture_flags_ignored: boolean }}
 */
function evaluateSideEffect(effect, fixture) {
  const normalized = normalizeEffect(effect);
  const flagsIgnored = true;
  if (isBlockedEffect(normalized)) {
    return {
      allowed: false,
      reason: BLOCK_REASON,
      effect: normalized,
      fixture_flags_ignored: flagsIgnored,
      fixture_allow_writes: !!(fixture && fixture.allow_writes),
      fixture_whatsapp_suppressed: fixture ? fixture.whatsapp_suppressed !== false : true,
    };
  }
  return {
    allowed: true,
    reason: null,
    effect: normalized,
    fixture_flags_ignored: false,
  };
}

/**
 * Evaluate a tool call by name (agent/Hermes tool surface).
 */
function evaluateToolCall(toolName, fixture) {
  const name = normalizeToolName(toolName);
  if (isBlockedToolName(name)) {
    return {
      allowed: false,
      reason: BLOCK_REASON,
      tool: name,
      effect: toolNameToEffect(name),
      fixture_flags_ignored: true,
      fixture_allow_writes: !!(fixture && fixture.allow_writes),
    };
  }
  return {
    allowed: true,
    reason: null,
    tool: name,
    effect: null,
    fixture_flags_ignored: false,
  };
}

function toolNameToEffect(toolName) {
  const lower = String(toolName || '').toLowerCase();
  if (lower.includes('booking')) return 'booking_create';
  if (lower.includes('payment') || lower.includes('stripe')) return 'payment_link_create';
  if (lower.includes('whatsapp')) return 'whatsapp_send';
  if (lower.includes('email')) return 'email_send';
  return 'unknown';
}

/**
 * Guarded dispatch: invokes fn only when allowed; otherwise returns a block result.
 */
function guardedDispatch(effect, fixture, fn) {
  const gate = evaluateSideEffect(effect, fixture);
  if (!gate.allowed) {
    return {
      ok: false,
      blocked: true,
      success: false,
      reason: gate.reason,
      effect: gate.effect,
      fixture_flags_ignored: gate.fixture_flags_ignored,
    };
  }
  return fn();
}

/**
 * Guarded tool call wrapper.
 */
function guardedToolCall(toolName, fixture, fn) {
  const gate = evaluateToolCall(toolName, fixture);
  if (!gate.allowed) {
    return {
      ok: false,
      blocked: true,
      success: false,
      tool: gate.tool,
      reason: gate.reason,
      effect: gate.effect,
      fixture_flags_ignored: gate.fixture_flags_ignored,
    };
  }
  return fn();
}

module.exports = {
  BLOCKED_EFFECTS,
  BLOCKED_TOOL_NAMES,
  BLOCK_REASON,
  isBlockedEffect,
  isBlockedToolName,
  evaluateSideEffect,
  evaluateToolCall,
  guardedDispatch,
  guardedToolCall,
};
