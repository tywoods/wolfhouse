'use strict';

/**
 * Luna Personality — closed WhatsApp style packs (wording/cadence/warmth/emoji only).
 *
 * Product name: Luna Personality (supersedes Luna Voices). Same Luna; no second
 * bot, SOUL, model, TTS, or pipeline. Server owns every pack. Callers, guests,
 * and the DB may persist only a closed ID — never prompt text.
 */

const PRODUCT_NAME = 'Luna Personality';
const SUPERSEDES = 'Luna Voices';
const CHANNEL = 'whatsapp';
const SETTINGS_KEY = 'luna_personality';
const DEFAULT_PERSONALITY_ID = 'sunny';
const CLOSED_PERSONALITY_IDS = Object.freeze(['sunny', 'calm', 'concise', 'extra']);

const CALLER_STYLE_KEYS = Object.freeze([
  'prompt',
  'style_prompt',
  'stylePrompt',
  'instruction',
  'instructions',
  'system_prompt',
  'voice_prompt',
  'editor',
]);

const PACKS = Object.freeze({
  sunny: Object.freeze({
    id: 'sunny',
    label: 'Sunny',
    instruction: [
      'Luna Personality this turn: sunny (DEFAULT — current live Wolf-House tone).',
      'Upbeat playful surf-host warmth. Light emoji (usually 0–2, tasteful emoji, never a wall).',
      'Friendly, human WhatsApp cadence. One clear next step.',
      'Wording/cadence/warmth/emoji only. Never change facts, prices, availability, open spots,',
      'permissions, tool choice or results, identity, booking/payment state, URLs, confirmations,',
      'handoff decisions, or language.',
    ].join(' '),
  }),
  calm: Object.freeze({
    id: 'calm',
    label: 'Calm',
    instruction: [
      'Luna Personality this turn: calm.',
      'Patient, reassuring, low-key. Soft warmth, fewer emoji, no hype, no elongated openers.',
      'Steady WhatsApp cadence. One clear next step.',
      'Wording/cadence/warmth/emoji only. Never change facts, prices, availability, open spots,',
      'permissions, tool choice or results, identity, booking/payment state, URLs, confirmations,',
      'handoff decisions, or language.',
    ].join(' '),
  }),
  concise: Object.freeze({
    id: 'concise',
    label: 'Concise',
    instruction: [
      'Luna Personality this turn: concise.',
      'Friendly but short. Tight sentences, minimal emoji, no extra cheer.',
      'Keep the same next step in fewer words.',
      'Wording/cadence/warmth/emoji only. Never change facts, prices, availability, open spots,',
      'permissions, tool choice or results, identity, booking/payment state, URLs, confirmations,',
      'handoff decisions, or language.',
    ].join(' '),
  }),
  extra: Object.freeze({
    id: 'extra',
    label: 'Extra',
    instruction: [
      'Luna Personality this turn: extra.',
      'Ultra bright, over-the-top friendly surf-host energy. More emoji than sunny, still readable.',
      'Celebratory cadence without inventing facts.',
      'Wording/cadence/warmth/emoji only. Never change facts, prices, availability, open spots,',
      'permissions, tool choice or results, identity, booking/payment state, URLs, confirmations,',
      'handoff decisions, or language.',
    ].join(' '),
  }),
});

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isClosedPersonalityId(value) {
  const id = trimStr(value).toLowerCase();
  return CLOSED_PERSONALITY_IDS.includes(id);
}

function normalizeStoredPersonalityId(value) {
  if (value == null || trimStr(value) === '') {
    return { id: DEFAULT_PERSONALITY_ID, source: 'default' };
  }
  const id = trimStr(value).toLowerCase();
  if (CLOSED_PERSONALITY_IDS.includes(id)) {
    return { id, source: 'stored' };
  }
  return { id: DEFAULT_PERSONALITY_ID, source: 'invalid_fallback' };
}

function getPersonalityPack(id) {
  const normalized = isClosedPersonalityId(id)
    ? trimStr(id).toLowerCase()
    : DEFAULT_PERSONALITY_ID;
  return PACKS[normalized];
}

function assertNoCallerStyleText(body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const key of CALLER_STYLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      const err = new Error('caller_style_text_rejected');
      err.code = 'caller_style_text_rejected';
      throw err;
    }
  }
  return true;
}

function personalityObservability(input) {
  const a = input || {};
  return {
    tenant_id: a.tenant_id == null ? null : String(a.tenant_id),
    channel: a.channel == null ? CHANNEL : String(a.channel),
    personality_id: isClosedPersonalityId(a.personality_id)
      ? String(a.personality_id).trim().toLowerCase()
      : DEFAULT_PERSONALITY_ID,
    source: a.source == null ? null : String(a.source),
    fallback_reason: a.fallback_reason == null ? null : String(a.fallback_reason),
  };
}

module.exports = {
  PRODUCT_NAME,
  SUPERSEDES,
  CHANNEL,
  SETTINGS_KEY,
  DEFAULT_PERSONALITY_ID,
  CLOSED_PERSONALITY_IDS,
  CALLER_STYLE_KEYS,
  PACKS,
  isClosedPersonalityId,
  normalizeStoredPersonalityId,
  getPersonalityPack,
  assertNoCallerStyleText,
  personalityObservability,
};
