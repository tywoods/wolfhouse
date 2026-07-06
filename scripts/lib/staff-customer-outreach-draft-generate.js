/**
 * Staff Portal — Luna-generated customer outreach draft (no WhatsApp send).
 * Tenant-scoped prompt uses client personality / baseline voice.
 *
 * @module staff-customer-outreach-draft-generate
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveActivePersonality } = require('./luna-guest-personality-config');
const { callLunaAiJsonChat, resolveLunaAiProvider } = require('./luna-ai-provider');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
const NOTES_MAX = 2000;
const DRAFT_MAX = 4000;
const RECIPIENT_NAMES_MAX = 12;

function trimText(value, maxLen) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.slice(0, maxLen);
}

function loadBaselineJson(clientSlug) {
  const slug = trimText(clientSlug);
  if (!slug) return null;
  try {
    const filePath = path.join(CONFIG_DIR, `${slug}.baseline.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Tenant voice for outreach draft generation (config-only, no DB).
 *
 * @param {string} clientSlug
 * @returns {{ client_slug: string, brand_name: string, assistant_name: string, voice_summary: string }}
 */
function loadTenantOutreachVoice(clientSlug) {
  const slug = trimText(clientSlug) || 'wolfhouse-somo';
  const resolved = resolveActivePersonality(slug);
  const baseline = loadBaselineJson(slug);
  const persona = baseline && baseline.persona;
  const deployIdentity = baseline && baseline.deploy_config && baseline.deploy_config.identity;
  const brandName = trimText(persona && persona.brand_name)
    || trimText(deployIdentity && deployIdentity.name)
    || trimText(baseline && baseline._meta && baseline._meta.client_name)
    || slug;
  const voiceSummary = trimText(resolved.personality && resolved.personality.voice_summary)
    || trimText(persona && persona.voice_summary)
    || 'Warm, helpful front desk — concise WhatsApp tone, one clear question when needed.';
  return {
    client_slug: slug,
    brand_name: brandName,
    assistant_name: trimText(resolved.assistant_name) || 'Luna',
    voice_summary: voiceSummary,
  };
}

function parseGenerateRequestBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const notes = trimText(b.notes, NOTES_MAX);
  if (!notes) return { ok: false, error: 'notes is required' };

  const names = [];
  const src = Array.isArray(b.recipient_names) ? b.recipient_names : [];
  for (const item of src) {
    const name = trimText(item, 80);
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= RECIPIENT_NAMES_MAX) break;
  }

  const recipientCount = b.recipient_count != null
    ? Math.max(0, Math.min(500, Number(b.recipient_count) || 0))
    : names.length;

  return {
    ok: true,
    value: {
      notes,
      recipient_count: recipientCount,
      recipient_names: names,
    },
  };
}

function buildRecipientContext({ recipient_count: count, recipient_names: names }) {
  if (!count && !names.length) return 'Bulk outreach to selected customers.';
  if (names.length === 1 && count <= 1) {
    return `Outreach to one customer: ${names[0]}.`;
  }
  if (names.length > 0) {
    const listed = names.join(', ');
    if (count > names.length) {
      return `Outreach to ${count} customers (including: ${listed}).`;
    }
    return `Outreach to ${names.length} customers: ${listed}.`;
  }
  return `Outreach to ${count} selected customers.`;
}

function buildCustomerOutreachDraftPrompt(voice, input) {
  const recipientContext = buildRecipientContext(input);
  const system = [
    `You draft WhatsApp outreach messages for ${voice.brand_name} staff.`,
    `Write in ${voice.assistant_name}'s voice: ${voice.voice_summary}`,
    '',
    'Output rules:',
    '- Return ONLY the WhatsApp message body text. No JSON, no markdown fences, no subject line.',
    '- Concise WhatsApp style: short paragraphs, friendly, human.',
    '- Match the tenant voice; never sound corporate or robotic.',
    '- Do NOT invent availability, prices, discounts, payment links, or booking confirmations.',
    '- Do NOT promise anything not stated in the staff notes or recipient context.',
    '- Do NOT mention internal systems (composer, staging, AI, templates, CRM, Staff API).',
    '- One clear call-to-action or question when appropriate.',
    '- If notes are vague, keep the message general and invite a reply — do not fill gaps with facts.',
  ].join('\n');

  const user = [
    recipientContext,
    '',
    'Staff notes for Luna:',
    input.notes,
    '',
    'Draft the polished WhatsApp message now.',
  ].join('\n');

  return { system, user };
}

function normalizeGeneratedDraft(text) {
  let out = trimText(text, DRAFT_MAX);
  if (!out) return '';
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  return trimText(out, DRAFT_MAX);
}

/**
 * Generate a polished outreach draft from staff notes (no send).
 *
 * @param {string} clientSlug
 * @param {object} body
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: true, body: string, voice: object } | { ok: false, status: number, error: string, detail?: string }>}
 */
async function generateCustomerOutreachDraft(clientSlug, body, opts = {}) {
  const env = opts.env || process.env;
  const parsed = parseGenerateRequestBody(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }

  const cfg = resolveLunaAiProvider(env);
  if (!cfg.enabled || !cfg.apiKey) {
    return { ok: false, status: 503, error: 'ai_not_configured', detail: 'Luna AI provider is not configured' };
  }

  const voice = loadTenantOutreachVoice(clientSlug);
  const prompt = buildCustomerOutreachDraftPrompt(voice, parsed.value);

  let raw;
  try {
    raw = await callLunaAiJsonChat({
      env,
      fetchImpl: opts.fetchImpl,
      system: prompt.system,
      user: prompt.user,
      maxTokens: 512,
      temperature: 0.6,
      call_label: 'customer_outreach_draft_generate',
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: 'generation_failed',
      detail: err && err.message ? String(err.message).slice(0, 240) : 'AI call failed',
    };
  }

  const draftBody = normalizeGeneratedDraft(raw);
  if (!draftBody) {
    return { ok: false, status: 502, error: 'empty_generation', detail: 'Model returned an empty draft' };
  }

  return {
    ok: true,
    body: draftBody,
    voice: {
      brand_name: voice.brand_name,
      assistant_name: voice.assistant_name,
    },
  };
}

module.exports = {
  NOTES_MAX,
  DRAFT_MAX,
  loadTenantOutreachVoice,
  parseGenerateRequestBody,
  buildCustomerOutreachDraftPrompt,
  generateCustomerOutreachDraft,
};
