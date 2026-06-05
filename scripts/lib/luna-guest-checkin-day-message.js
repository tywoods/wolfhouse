/**
 * Phase 19 — Luna check-in day message builder (compute-only, no send/write).
 *
 * Scheduled ~10:00 local Wolfhouse time on check-in day.
 * Welcome + arrival logistics; balance payment link only when allowed.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const {
  buildPlaybookMetadata,
  loadLunaMessagingPlaybook,
  getLunaMessagingPlaybookValue,
} = require('./luna-client-messaging-playbook');

const DEFAULT_CLIENT = 'wolfhouse-somo';
const DEFAULT_TIMEZONE = 'Europe/Madrid';
const SCHEDULED_LOCAL_HOUR = 10;
const SCHEDULED_LOCAL_MINUTE = 0;

const CONFIRMED_STATUSES = new Set(['confirmed']);

const CASH_BANK_RE = /\b(?:cash|contanti|efectivo|esp[eè]ces|bar|bank transfer|wire transfer|transfer(?:encia|encia bancaria)?|bonifico|virement|überweisung)\b/i;

const CHECKIN_DAY_SAFETY_FLAGS = Object.freeze({
  preview_only:               true,
  no_write_performed:           true,
  sends_whatsapp:               false,
  creates_booking:              false,
  creates_payment:              false,
  creates_stripe_link:          false,
  calls_n8n:                    false,
  updates_confirmation_sent_at: false,
});

const CHECKIN_DAY_MESSAGE_RULES = Object.freeze({
  scheduled_local_time:         '10:00',
  scheduled_timezone:           DEFAULT_TIMEZONE,
  confirmed_bookings_only:      true,
  no_duplicate_send:            true,
  respect_bot_pause:            true,
  respect_live_send_gates:      true,
  exclude_bed_number:           true,
  room_number_when_assigned:    true,
  payment_link_when_balance_due: true,
  suppress_payment_if_cash_bank_preference: true,
  log_payment_link_decision:    true,
});

const CHECKIN_DAY_TEMPLATES = Object.freeze({
  en: {
    with_payment: `Heyyy ☀️ welcome to the Wolfhouse family!

Today is check-in day and we're so excited to have you here with us in Somo 🌊
Get ready for surf, beautiful beaches and good vibes.

Address: {address}
Gate code: {gate_code}

If you already know your arrival time or flight info, send it here so we can organize everything smoothly.

And if you'd like to settle the remaining balance by card, you can do it here:
{balance_payment_link}

See you soon ☀️`,
    without_payment: `Heyyy ☀️ welcome to the Wolfhouse family!

Today is check-in day and we're so excited to have you here with us in Somo 🌊
Get ready for surf, beautiful beaches and good vibes.

Address: {address}
Gate code: {gate_code}

If you already know your arrival time or flight info, send it here so we can organize everything smoothly.

See you soon ☀️`,
    arrival_ask: 'If you already know your arrival time or flight info, send it here so we can organize everything smoothly.',
    payment_line: "And if you'd like to settle the remaining balance by card, you can do it here:\n{balance_payment_link}",
  },
  it: {
    with_payment: `Ciaooo ☀️ benvenuti nella famiglia Wolfhouse!

Oggi è il giorno del check-in e siamo felicissimi di avervi qui con noi a Somo 🌊
Preparatevi per surf, spiagge bellissime e good vibes.

Indirizzo: {address}
Codice cancello: {gate_code}

Se sapete già orario di arrivo o info del volo, mandatemele qui così ci organizziamo al meglio.

Se volete saldare il rimanente con carta, potete farlo qui:
{balance_payment_link}

A prestissimo ☀️`,
    without_payment: `Ciaooo ☀️ benvenuti nella famiglia Wolfhouse!

Oggi è il giorno del check-in e siamo felicissimi di avervi qui con noi a Somo 🌊
Preparatevi per surf, spiagge bellissime e good vibes.

Indirizzo: {address}
Codice cancello: {gate_code}

Se sapete già orario di arrivo o info del volo, mandatemele qui così ci organizziamo al meglio.

A prestissimo ☀️`,
    arrival_ask: 'Se sapete già orario di arrivo o info del volo, mandatemele qui così ci organizziamo al meglio.',
    payment_line: 'Se volete saldare il rimanente con carta, potete farlo qui:\n{balance_payment_link}',
  },
});

const BED_NUMBER_RE = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;

function resolveLang(language, templatesByLang) {
  const code = String(language || 'en').trim().toLowerCase().slice(0, 2);
  const source = templatesByLang || CHECKIN_DAY_TEMPLATES;
  return source[code] ? code : 'en';
}

function resolveCheckinDayTemplates(clientSlug) {
  const loaded = loadLunaMessagingPlaybook(clientSlug);
  if (!loaded.playbook_loaded) {
    return { playbook_loaded: false, templates: CHECKIN_DAY_TEMPLATES, source: 'built_in_fallback' };
  }

  const playbookCheckin = getLunaMessagingPlaybookValue(clientSlug, 'checkin_day_templates', null);
  if (!playbookCheckin || !playbookCheckin.en) {
    return { playbook_loaded: true, templates: CHECKIN_DAY_TEMPLATES, source: 'built_in_fallback' };
  }

  const merged = {
    en: {
      ...CHECKIN_DAY_TEMPLATES.en,
      ...(playbookCheckin.en || {}),
    },
    it: {
      ...CHECKIN_DAY_TEMPLATES.it,
      ...(playbookCheckin.it || {}),
    },
  };

  return {
    playbook_loaded: true,
    templates: merged,
    source: 'messaging_playbook',
    payment_suppression: playbookCheckin.payment_suppression || null,
  };
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function loadClientCheckinConfig(clientSlug) {
  try {
    const cfgPath = path.join(__dirname, '..', '..', 'config', 'clients', `${clientSlug}.baseline.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      timezone: cfg.operations?.timezone || DEFAULT_TIMEZONE,
      address: cfg.confirmation?.address || cfg.property?.address || null,
      gate_code: cfg.confirmation?.gate_code || cfg.property?.gate_code || null,
      include_address: cfg.confirmation?.include_address === true,
    };
  } catch (_) {
    return { timezone: DEFAULT_TIMEZONE, address: null, gate_code: null, include_address: false };
  }
}

function collectConversationTexts(input, context) {
  const texts = [];
  const src = input || {};
  const ctx = context || {};

  for (const msg of src.conversation_messages || ctx.conversation_messages || []) {
    if (typeof msg === 'string') texts.push(msg);
    else if (msg && msg.text) texts.push(String(msg.text));
    else if (msg && msg.message_text) texts.push(String(msg.message_text));
  }

  for (const pref of src.payment_preference_history || ctx.payment_preference_history || []) {
    if (typeof pref === 'string') texts.push(pref);
    else if (pref && pref.message_text) texts.push(String(pref.message_text));
    else if (pref && pref.method) texts.push(String(pref.method));
  }

  return texts;
}

function guestAskedCashOrBankTransfer(input, context) {
  const texts = collectConversationTexts(input, context);
  return texts.some((t) => CASH_BANK_RE.test(t));
}

function resolveBalanceDueCents(input, context) {
  const src = input || {};
  const ctx = context || {};
  if (src.balance_due_cents != null) return Number(src.balance_due_cents);
  if (ctx.balance_due_cents != null) return Number(ctx.balance_due_cents);
  if (src.balance_due != null) return Math.round(Number(src.balance_due) * 100);
  return 0;
}

function shouldIncludeBalancePaymentLink(input, context) {
  const balanceDue = resolveBalanceDueCents(input, context);
  if (!(balanceDue > 0)) {
    return { include: false, reason: 'balance_due_zero_or_missing' };
  }
  if (guestAskedCashOrBankTransfer(input, context)) {
    return { include: false, reason: 'guest_previously_asked_cash_or_bank_transfer' };
  }
  const link = trimStr((input || {}).balance_payment_link || (context || {}).balance_payment_link);
  if (!link) {
    return { include: false, reason: 'balance_payment_link_missing' };
  }
  return { include: true, reason: 'balance_due_with_card_option_allowed' };
}

function fillTemplate(template, vars) {
  return String(template || '')
    .replace(/\{address\}/g, vars.address || '')
    .replace(/\{gate_code\}/g, vars.gate_code || '')
    .replace(/\{balance_payment_link\}/g, vars.balance_payment_link || '')
    .replace(/\{room_number\}/g, vars.room_number || '')
    .trim();
}

function buildCheckinDayMessageBody(input, context) {
  const src = input || {};
  const ctx = context || {};
  const clientSlug = trimStr(src.client_slug || ctx.client_slug) || DEFAULT_CLIENT;
  const templateBundle = (ctx.resolveCheckinDayTemplates || resolveCheckinDayTemplates)(clientSlug);
  const templatesByLang = templateBundle.templates;
  const lang = resolveLang(src.language || ctx.language, templatesByLang);
  const tpl = templatesByLang[lang];
  const clientCfg = (ctx.loadClientCheckinConfig || loadClientCheckinConfig)(clientSlug);

  const address = trimStr(src.address || ctx.address) || trimStr(clientCfg.address);
  const gateCode = trimStr(src.gate_code || ctx.gate_code) || trimStr(clientCfg.gate_code);
  const paymentDecision = shouldIncludeBalancePaymentLink(src, ctx);
  const balanceLink = trimStr(src.balance_payment_link || ctx.balance_payment_link);

  const arrivalKnown = src.arrival_time_known === true || ctx.arrival_time_known === true
    || src.flight_info_known === true || ctx.flight_info_known === true;

  const arrivalAsk = tpl.arrival_ask || CHECKIN_DAY_TEMPLATES[lang].arrival_ask;

  let body = paymentDecision.include ? tpl.with_payment : tpl.without_payment;
  body = fillTemplate(body, {
    address: address || '(address on file)',
    gate_code: gateCode || '(provided separately)',
    balance_payment_link: balanceLink,
  });

  if (arrivalKnown && arrivalAsk) {
    body = body.replace(arrivalAsk, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  const roomNumber = trimStr(src.room_number || ctx.room_number);
  const roomAllowed = src.room_assigned === true || ctx.room_assigned === true;
  if (roomNumber && roomAllowed) {
    const roomLabel = lang === 'it' ? 'Camera' : 'Room';
    const gateLine = gateCode
      ? (lang === 'it' ? `Codice cancello: ${gateCode}` : `Gate code: ${gateCode}`)
      : null;
    if (gateLine && body.includes(gateLine)) {
      body = body.replace(gateLine, `${gateLine}\n${roomLabel}: ${roomNumber}`);
    } else {
      const splitAt = body.indexOf('\n\n');
      body = splitAt > -1
        ? `${body.slice(0, splitAt)}\n${roomLabel}: ${roomNumber}${body.slice(splitAt)}`
        : `${body}\n${roomLabel}: ${roomNumber}`;
    }
  }

  if (BED_NUMBER_RE.test(body)) {
    throw new Error('checkin_day_message_must_not_include_bed_number');
  }

  return {
    message_text: body,
    language: lang,
    payment_link_included: paymentDecision.include,
    payment_link_decision_reason: paymentDecision.reason,
    address,
    gate_code: gateCode,
    templates_source: templateBundle.source,
    playbook_loaded: templateBundle.playbook_loaded === true,
  };
}

function collectSendBlockedGates(input, context, env) {
  const e = env || process.env;
  const gates = [];
  const ctx = context || {};

  if (String(e.WHATSAPP_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false') {
    gates.push('whatsapp_dry_run_active');
  }
  if (String(e.LUNA_AUTO_SEND_ENABLED || '').trim().toLowerCase() !== 'true') {
    gates.push('luna_auto_send_not_enabled');
  }
  if (ctx.bot_paused === true || (ctx.gate && ctx.gate.bot_paused === true)) {
    gates.push('gate_bot_paused');
  }
  if (ctx.live_send_blocked === true || (ctx.gate && ctx.gate.live_send_blocked === true)) {
    gates.push('gate_live_send_blocked');
  }
  return gates;
}

/**
 * @param {object} input — booking + guest context
 * @param {object} [context] — optional overrides, conversation history
 * @param {object} [env] — env gates
 */
function planLunaCheckinDayMessage(input, context = {}, env = process.env) {
  const src = input || {};
  const ctx = context || {};
  const blockedGates = collectSendBlockedGates(src, ctx, env);
  const blockedReasons = [];

  const status = trimStr(src.booking_status || ctx.booking_status).toLowerCase();
  if (status && !CONFIRMED_STATUSES.has(status)) {
    blockedReasons.push('booking_not_confirmed');
  }

  if (src.checkin_day_sent_at || ctx.checkin_day_sent_at) {
    blockedReasons.push('checkin_day_already_sent');
  }

  const checkInDate = trimStr(src.check_in || ctx.check_in);
  if (!checkInDate) blockedReasons.push('check_in_date_missing');

  let built;
  try {
    built = buildCheckinDayMessageBody(src, ctx);
  } catch (err) {
    return {
      success: false,
      error: err.message,
      ...CHECKIN_DAY_SAFETY_FLAGS,
      automation_planner: true,
      message_kind: 'checkin_day',
      blocked_reasons: [...blockedReasons, err.message],
      blocked_gates: blockedGates,
      send_ready: false,
      rules: CHECKIN_DAY_MESSAGE_RULES,
    };
  }

  const clientSlug = trimStr(src.client_slug || ctx.client_slug) || DEFAULT_CLIENT;
  const messaging_playbook = buildPlaybookMetadata(clientSlug);
  const templateBundle = resolveCheckinDayTemplates(clientSlug);

  const sendReady = blockedReasons.length === 0 && blockedGates.length === 0;

  return {
    success: true,
    ...CHECKIN_DAY_SAFETY_FLAGS,
    automation_planner: true,
    message_kind: 'checkin_day',
    client_slug: clientSlug,
    messaging_playbook,
    templates_source: templateBundle.source,
    scheduled_local_time: CHECKIN_DAY_MESSAGE_RULES.scheduled_local_time,
    scheduled_timezone: (ctx.loadClientCheckinConfig || loadClientCheckinConfig)(
      trimStr(src.client_slug || ctx.client_slug) || DEFAULT_CLIENT,
    ).timezone,
    check_in: checkInDate || null,
    message_text: built.message_text,
    language: built.language,
    payment_link_included: built.payment_link_included,
    payment_link_decision_reason: built.payment_link_decision_reason,
    payment_link_log: {
      included: built.payment_link_included,
      reason: built.payment_link_decision_reason,
    },
    balance_due_cents: resolveBalanceDueCents(src, ctx),
    address: built.address,
    gate_code: built.gate_code,
    blocked_reasons: blockedReasons,
    blocked_gates: blockedGates,
    send_ready: sendReady,
    action_ready_now: false,
    rules: CHECKIN_DAY_MESSAGE_RULES,
    templates: templateBundle.templates,
  };
}

module.exports = {
  planLunaCheckinDayMessage,
  buildCheckinDayMessageBody,
  shouldIncludeBalancePaymentLink,
  guestAskedCashOrBankTransfer,
  CHECKIN_DAY_TEMPLATES,
  CHECKIN_DAY_MESSAGE_RULES,
  CHECKIN_DAY_SAFETY_FLAGS,
  SCHEDULED_LOCAL_HOUR,
  SCHEDULED_LOCAL_MINUTE,
  loadClientCheckinConfig,
  resolveCheckinDayTemplates,
};
