'use strict';

/**
 * Guest copy before a needs-human flag. Short, in the guest language.
 * Do not double-send if Luna already told them a person is coming.
 */

const WARM_NOTE = Object.freeze({
  en: 'A staff member will help you from here — someone from the team will write to you shortly.',
  es: 'Una persona del equipo te va a ayudar — enseguida te escriben.',
  it: 'Una persona del team ti aiuterà — ti scrivono a breve.',
  de: 'Ein Teammitglied hilft dir weiter — jemand schreibt dir gleich.',
  fr: "Un membre de l'equipe va t'aider — quelqu'un t'ecrira tout de suite.",
});

const ALREADY_SENT_RES = Object.freeze([
  /staff member will help/i,
  /someone from the team will write/i,
  /persona del equipo te va a ayudar/i,
  /persona del team ti aiuter/i,
  /teammitglied hilft dir/i,
  /membre de l['']equipe va t['']aider/i,
]);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function handoffWarmNoteLanguage(language) {
  const lang = trimStr(language).toLowerCase().slice(0, 2);
  return WARM_NOTE[lang] ? lang : 'en';
}

function handoffWarmNoteText(language) {
  return WARM_NOTE[handoffWarmNoteLanguage(language)];
}

function isHandoffWarmNote(text) {
  const raw = trimStr(text);
  if (!raw) return false;
  return ALREADY_SENT_RES.some((re) => re.test(raw));
}

function shouldSendHandoffWarmNote(input) {
  const src = input || {};
  const language = handoffWarmNoteLanguage(src.language);
  const text = handoffWarmNoteText(language);
  const prior = Array.isArray(src.recentOutboundTexts) ? src.recentOutboundTexts : [];
  if (prior.some(isHandoffWarmNote)) {
    return { send: false, reason: 'already_sent', language, text };
  }
  return { send: true, reason: null, language, text };
}

async function sendHandoffWarmNoteIfNeeded(input) {
  const src = input || {};
  const plan = shouldSendHandoffWarmNote(src);
  if (!plan.send) {
    return { sent: false, skipped: plan.reason, needed: false, language: plan.language, text: plan.text };
  }
  if (typeof src.sendGuestNote !== 'function') {
    return { sent: false, skipped: 'sender_missing', needed: true, language: plan.language, text: plan.text };
  }
  const result = await src.sendGuestNote({
    text: plan.text,
    language: plan.language,
    conversation_id: src.conversation_id || null,
    phone: src.phone || null,
  });
  const sent = !!(result && result.ok !== false && result.sent !== false && result.success !== false);
  return {
    sent,
    skipped: sent ? null : ((result && result.blocked_reason) || 'send_not_confirmed'),
    needed: true,
    language: plan.language,
    text: plan.text,
    result: result || null,
  };
}

function createHandoffWarmNoteSender(env) {
  return async function sendGuestNote(payload) {
    const { sendLunaWhatsAppMessage } = require('./luna-whatsapp-provider');
    const src = payload || {};
    const sent = await sendLunaWhatsAppMessage({
      to: src.phone,
      message: src.text,
      client_slug: 'wolfhouse-somo',
      idempotency_key: src.conversation_id ? `handoff-warm:${src.conversation_id}` : undefined,
    }, env || process.env);
    return {
      ok: sent && sent.success === true,
      sent: sent && sent.send_performed === true,
      blocked_reason: sent && sent.blocked_reason,
      result: sent || null,
    };
  };
}

module.exports = {
  WARM_NOTE,
  handoffWarmNoteLanguage,
  handoffWarmNoteText,
  isHandoffWarmNote,
  shouldSendHandoffWarmNote,
  sendHandoffWarmNoteIfNeeded,
  createHandoffWarmNoteSender,
};
