'use strict';

/**
 * Guest copy before a needs-human flag. Short, in the guest language.
 * Do not double-send if Luna already told them a person is coming.
 */

const WARM_NOTE = Object.freeze({
  en: "I'm getting a staff member to help you, they'll be with you shortly.",
  es: 'Voy a buscar a alguien del equipo para ayudarte, enseguida estarán contigo.',
  it: 'Sto chiamando un membro del team per aiutarti, saranno da te a breve.',
  de: 'Ich hole ein Teammitglied, das dir hilft — jemand ist gleich bei dir.',
  fr: "Je vais chercher quelqu'un de l'equipe pour t'aider, ils seront la tout de suite.",
});

const ALREADY_SENT_RES = Object.freeze([
  /getting .{0,60}staff member to help/i,
  /they'll be with you shortly/i,
  /voy a buscar a alguien del equipo/i,
  /enseguida estar/i,
  /sto chiamando un membro del team/i,
  /ich hole ein teammitglied/i,
  /je vais chercher quelqu['']un de l['']equipe/i,
  /staff member will help/i,
  /getting .{1,60} to help/i,
]);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeStaffMemberName(raw) {
  const name = trimStr(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
  if (!name) return '';
  return name.slice(0, 60);
}

function handoffWarmNoteLanguage(language) {
  const lang = trimStr(language).toLowerCase().slice(0, 2);
  return WARM_NOTE[lang] ? lang : 'en';
}

const NAMED_NOTE = Object.freeze({
  en: (n) => "I'm getting " + n + " to help you, they'll be with you shortly.",
  es: (n) => 'Voy a buscar a ' + n + ' para ayudarte, enseguida estará contigo.',
  it: (n) => 'Sto chiamando ' + n + ' per aiutarti, sarà da te a breve.',
  de: (n) => 'Ich hole ' + n + ', der dir hilft — jemand ist gleich bei dir.',
  fr: (n) => "Je vais chercher " + n + " pour t'aider, iels seront la tout de suite.",
});

function handoffWarmNoteText(language, staffName) {
  const lang = handoffWarmNoteLanguage(language);
  const name = normalizeStaffMemberName(staffName);
  if (!name) return WARM_NOTE[lang];
  return NAMED_NOTE[lang](name);
}

function isHandoffWarmNote(text) {
  const raw = trimStr(text);
  if (!raw) return false;
  return ALREADY_SENT_RES.some((re) => re.test(raw));
}

function shouldSendHandoffWarmNote(input) {
  const src = input || {};
  const language = handoffWarmNoteLanguage(src.language);
  const text = handoffWarmNoteText(language, src.staff_member_name);
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
  normalizeStaffMemberName,
  isHandoffWarmNote,
  shouldSendHandoffWarmNote,
  sendHandoffWarmNoteIfNeeded,
  createHandoffWarmNoteSender,
};
