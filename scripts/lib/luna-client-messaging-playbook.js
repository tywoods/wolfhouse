/**
 * Phase 19b.1 — Luna client messaging playbook loader (config-only, no DB/send).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const {
  buildCamiConfirmationPreview,
} = require('./luna-guest-confirmation-personality-copy');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'clients');

const SUPPORTED_CLIENTS = new Set(['wolfhouse-somo']);

const _cache = new Map();

const MISSING_FIELD_MAP = {
  check_in:       'dates',
  check_out:      'dates',
  guests:         'guest_count',
  package_code:   'package',
  guest_name:     'name',
  email:          'email',
  payment_choice: 'payment_choice',
  room_type:      'room_preference',
  arrival_time:   'arrival_time',
  transfer_needed: 'transfer_needed',
};

const HANDOFF_REASON_MAP = {
  low_confidence:          'low_confidence',
  cancel_request:          'cancellation',
  cancellation:            'cancellation',
  refund:                  'refund',
  complaint:               'complaint',
  angry:                   'angry_guest',
  angry_guest:             'angry_guest',
  human_request:           'human_request',
  not_enough_availability: 'not_enough_availability',
  paid_date_change:        'paid_date_change',
};

function messagingConfigPath(clientSlug) {
  return path.join(CONFIG_DIR, `${String(clientSlug || '').trim()}.messaging.json`);
}

function loadBaselineHoldMinutes(clientSlug) {
  try {
    const p = path.join(CONFIG_DIR, `${clientSlug}.baseline.json`);
    if (!fs.existsSync(p)) return null;
    const baseline = JSON.parse(fs.readFileSync(p, 'utf8'));
    return baseline.payment && baseline.payment.hold_expiry_minutes != null
      ? baseline.payment.hold_expiry_minutes
      : null;
  } catch {
    return null;
  }
}

function loadLunaMessagingPlaybook(clientSlug) {
  const slug = String(clientSlug || 'wolfhouse-somo').trim() || 'wolfhouse-somo';

  if (_cache.has(slug)) return _cache.get(slug);

  const result = {
    playbook_loaded: false,
    client_slug:     slug,
    config_path:     messagingConfigPath(slug),
    playbook:        null,
  };

  if (!SUPPORTED_CLIENTS.has(slug)) {
    _cache.set(slug, result);
    return result;
  }

  if (!fs.existsSync(result.config_path)) {
    _cache.set(slug, result);
    return result;
  }

  try {
    result.playbook = JSON.parse(fs.readFileSync(result.config_path, 'utf8'));
    result.playbook_loaded = true;
  } catch {
    result.playbook_loaded = false;
    result.playbook = null;
  }

  _cache.set(slug, result);
  return result;
}

function getLunaMessagingPlaybookValue(clientSlug, dotPath, fallback = null) {
  const loaded = loadLunaMessagingPlaybook(clientSlug);
  if (!loaded.playbook_loaded || !loaded.playbook) return fallback;

  const parts = String(dotPath || '').split('.').filter(Boolean);
  let cur = loaded.playbook;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur === undefined ? fallback : cur;
}

function resolvePlaybookLang(language) {
  const code = String(language || 'en').trim().toLowerCase().slice(0, 2);
  return code === 'it' ? 'it' : 'en';
}

function pickLocalizedPlaybook(entry, language) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  const lang = resolvePlaybookLang(language);
  if (typeof entry[lang] === 'string') return entry[lang];
  if (typeof entry.en === 'string') return entry.en;
  return null;
}

function buildPlaybookMetadata(clientSlug) {
  const loaded = loadLunaMessagingPlaybook(clientSlug);
  if (!loaded.playbook_loaded) {
    return { playbook_loaded: false, client_slug: loaded.client_slug };
  }

  const p = loaded.playbook.personality || {};
  return {
    playbook_loaded:                true,
    client_slug:                    loaded.client_slug,
    personality_key:                p.personality_key || null,
    assistant_name:               p.assistant_name || null,
    brand_name:                     p.brand_name || null,
    display_name:                   p.display_name || null,
    same_warm_tone_all_languages:   p.same_warm_tone_all_languages === true,
    no_ai_mention:                  p.no_ai_mention === true,
  };
}

function buildConfigAlignmentWarnings(clientSlug) {
  const warnings = [];
  const holdHours = getLunaMessagingPlaybookValue(
    clientSlug,
    'hold_and_payment_rules.booking_hold_hours',
    null,
  );
  const baselineMinutes = loadBaselineHoldMinutes(clientSlug);

  if (holdHours != null && baselineMinutes != null && holdHours * 60 !== baselineMinutes) {
    warnings.push({
      code:               'hold_expiry_mismatch',
      messaging_hours:    holdHours,
      baseline_minutes:   baselineMinutes,
      message:            `Messaging playbook hold is ${holdHours}h but baseline hold_expiry_minutes is ${baselineMinutes}`,
    });
  }

  return warnings;
}

function buildPlaybookPromptContext(clientSlug) {
  const loaded = loadLunaMessagingPlaybook(clientSlug);
  if (!loaded.playbook_loaded) {
    return { playbook_loaded: false, client_slug: loaded.client_slug };
  }

  const pb = loaded.playbook;
  return {
    playbook_loaded:          true,
    client_slug:              loaded.client_slug,
    personality:              pb.personality || null,
    package_explanations:     pb.package_explanations || null,
    seasonal_price_reference: pb.seasonal_price_reference || null,
    hold_and_payment_rules:   pb.hold_and_payment_rules || null,
    transfer_templates:       pb.transfer_templates || null,
    checkin_day_templates:    pb.checkin_day_templates || null,
    guardrails:               pb.guardrails || null,
    quote_reply_templates: pb.quote_reply_templates
      ? {
        placeholders: pb.quote_reply_templates.placeholders || [],
        rules:        pb.quote_reply_templates.rules || [],
      }
      : null,
  };
}

function fillPlaceholders(template, values) {
  if (!template) return null;
  let out = template;
  for (const [key, val] of Object.entries(values || {})) {
    out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), val == null ? '' : String(val));
  }
  return out;
}

function getMissingFieldPrompt(clientSlug, field, language) {
  const playbookKey = MISSING_FIELD_MAP[field] || field;
  const prompts = getLunaMessagingPlaybookValue(clientSlug, 'missing_field_prompts', null);
  if (!prompts || !prompts[playbookKey]) return null;
  const lang = resolvePlaybookLang(language);
  const entry = prompts[playbookKey];
  return entry[lang] || entry.en || null;
}

function getHandoffTemplate(clientSlug, handoffReason, language) {
  const templates = getLunaMessagingPlaybookValue(clientSlug, 'handoff_templates', null);
  if (!templates) return null;
  const key = HANDOFF_REASON_MAP[handoffReason] || 'human_request';
  if (!templates[key]) return null;
  return pickLocalizedPlaybook(templates[key], language);
}

function buildQuoteReplyFromPlaybook(clientSlug, language, quote, fields) {
  const templates = getLunaMessagingPlaybookValue(clientSlug, 'quote_reply_templates', null);
  if (!templates || !quote || quote.success === false) return null;

  const template = pickLocalizedPlaybook(templates, language);
  if (!template) return null;

  const totalCents = quote.total_cents;
  const depositCents = quote.deposit_required_cents;
  if (totalCents == null || depositCents == null) return null;

  const pkgCode = (fields && fields.package_code) || quote.package_code || 'malibu';
  const pkgName = String(pkgCode).charAt(0).toUpperCase() + String(pkgCode).slice(1);

  return fillPlaceholders(template, {
    check_in:       fields?.check_in || '',
    check_out:      fields?.check_out || '',
    guest_count:    fields?.guest_count ?? fields?.guests ?? '',
    package_name:   pkgName,
    total_amount:   `€${(totalCents / 100).toFixed(2)}`,
    deposit_amount: `€${(depositCents / 100).toFixed(2)}`,
    full_amount:    `€${(totalCents / 100).toFixed(2)}`,
  });
}

function formatPlaybookEuro(cents) {
  if (cents == null) return '';
  return `€${(Number(cents) / 100).toFixed(0)}`;
}

/**
 * Tidy interpolation artifacts in a confirmation message WITHOUT destroying the
 * template's WhatsApp spacing.
 *
 * The booking confirmation template uses `\n\n` between blocks and `\n` between
 * fields (Booking/Paid/Balance, then Address/Gate code/Room, then the balance
 * link) so it reads as short labelled lines on WhatsApp. The previous cleanup
 * collapsed every run of whitespace with `/\s{2,}/ → ' '`, which also ate the
 * newlines and turned the whole thing into a single wall of text. This keeps
 * the line structure intact: it only collapses horizontal whitespace within a
 * line and drops label lines whose value interpolated empty (e.g. the
 * "Balance due: " line when no balance is owed).
 *
 * @param {string} message
 * @returns {string}
 */
function tidyConfirmationWhitespace(message) {
  return String(message || '')
    .split('\n')
    .map((line) => line
      .replace(/[ \t]{2,}/g, ' ')   // runs of spaces/tabs → one space (keep newlines)
      .replace(/\s+\./g, '.')        // " ." → "."
      .replace(/\.\s*\./g, '.')      // ".." → "."
      .trimEnd())
    .filter((line) => !/^[^\n:]{1,32}:\s*$/.test(line)) // drop "Label:" lines with empty value
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')      // never more than one blank line between blocks
    .trim();
}

/**
 * Build Cami/Wolfhouse confirmation preview text from messaging playbook templates.
 *
 * @param {string} clientSlug
 * @param {string|null} language
 * @param {object} fields — guest_name, booking_code, amount_paid_cents, balance_due_cents,
 *   address, gate_code, room_number, balance_payment_link, include_balance_link
 */
function buildConfirmationPreviewFromPlaybook(clientSlug, language, fields) {
  const personalityPreview = buildCamiConfirmationPreview(clientSlug, language, {
    ...fields,
    draft: fields,
  });
  if (personalityPreview.ok) {
    return {
      ok: true,
      message: personalityPreview.message,
      source: personalityPreview.source,
      template_source: personalityPreview.template_source,
      messaging_playbook: buildPlaybookMetadata(clientSlug),
      personality_id: personalityPreview.personality_id,
      includes_lessons: personalityPreview.includes_lessons,
      maps_link: personalityPreview.maps_link,
    };
  }

  const loaded = loadLunaMessagingPlaybook(clientSlug);
  const templates = getLunaMessagingPlaybookValue(clientSlug, 'confirmation_templates', null);
  const template = pickLocalizedPlaybook(templates, language);

  if (!loaded.playbook_loaded || !template) {
    return { ok: false, source: 'built_in_fallback' };
  }

  const balanceTemplates = getLunaMessagingPlaybookValue(clientSlug, 'balance_payment_templates', null);
  const cardOptionTpl = balanceTemplates && balanceTemplates.card_option_in_confirmation
    ? pickLocalizedPlaybook(balanceTemplates.card_option_in_confirmation, language)
    : null;

  let balancePaymentSection = '';
  if (fields && fields.include_balance_link && fields.balance_payment_link) {
    const sectionTpl = cardOptionTpl
      || "If you'd like to settle the remaining balance by card before arrival: {balance_payment_link}";
    balancePaymentSection = fillPlaceholders(sectionTpl, {
      balance_payment_link: fields.balance_payment_link,
    });
  }

  const gateDefault = (templates && templates.gate_code_default) || null;
  const balanceDueCents = fields && fields.balance_due_cents != null
    ? Number(fields.balance_due_cents)
    : 0;

  let message = fillPlaceholders(template, {
    guest_name:              (fields && fields.guest_name) || '',
    booking_code:            (fields && fields.booking_code) || '',
    amount_paid:             formatPlaybookEuro(fields && fields.amount_paid_cents),
    balance_due:             balanceDueCents > 0 ? formatPlaybookEuro(balanceDueCents) : '',
    address:                 (fields && fields.address) || '',
    gate_code:               (fields && fields.gate_code) || gateDefault || '',
    room_number:             (fields && fields.room_number) || '',
    balance_payment_section: balancePaymentSection ? balancePaymentSection.trim() : '',
  });

  message = tidyConfirmationWhitespace(message);

  return {
    ok:               true,
    message,
    source:           'messaging_playbook',
    template_source:  'confirmation_templates',
    messaging_playbook: buildPlaybookMetadata(clientSlug),
  };
}

function buildPlaybookActionGuidance(clientSlug, nextAction) {
  const loaded = loadLunaMessagingPlaybook(clientSlug);
  if (!loaded.playbook_loaded) return null;

  const pb = loaded.playbook;
  const guidance = { next_action: nextAction };

  switch (nextAction) {
    case 'ask_missing_field':
      guidance.template_source = 'missing_field_prompts';
      guidance.closing_hint = (pb.closing_strategy && pb.closing_strategy.steps && pb.closing_strategy.steps[0]) || null;
      break;
    case 'send_quote':
      guidance.template_source = 'quote_reply_templates';
      guidance.package_explanations_available = !!pb.package_explanations;
      guidance.closing_hint = 'after_quote ask deposit vs full';
      break;
    case 'create_booking_and_payment_draft':
      guidance.template_source = 'booking_close_templates';
      guidance.hold_and_payment_rules = pb.hold_and_payment_rules || null;
      guidance.do_not_confirm_before_webhook = true;
      break;
    case 'create_payment_link':
      guidance.template_source = 'payment_link_templates';
      guidance.no_proactive_hold_mention = pb.hold_and_payment_rules?.do_not_mention_hold_proactively === true;
      break;
    case 'handoff_to_staff':
    case 'unsupported':
      guidance.template_source = 'handoff_templates';
      break;
    default:
      guidance.template_source = null;
  }

  return guidance;
}

function clearLunaMessagingPlaybookCache() {
  _cache.clear();
}

module.exports = {
  loadLunaMessagingPlaybook,
  getLunaMessagingPlaybookValue,
  buildPlaybookPromptContext,
  buildPlaybookMetadata,
  buildConfigAlignmentWarnings,
  getMissingFieldPrompt,
  getHandoffTemplate,
  buildQuoteReplyFromPlaybook,
  buildConfirmationPreviewFromPlaybook,
  tidyConfirmationWhitespace,
  formatPlaybookEuro,
  buildPlaybookActionGuidance,
  clearLunaMessagingPlaybookCache,
  MISSING_FIELD_MAP,
  SUPPORTED_CLIENTS,
};
