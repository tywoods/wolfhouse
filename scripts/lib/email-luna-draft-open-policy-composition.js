'use strict';

/**
 * Production Luna email-open policy composition.
 *
 * Always issues an authentic envelope. Issues branded evidence/decision and
 * calls the Sunset author only when a real classifier and grounded-tool owners
 * are bound. Otherwise persists a server-owned deterministic safe
 * acknowledgment in EN/ES. Never forges lookalike author inputs.
 */

const util = require('node:util');
const { createEmailLunaDraftEnvelope } = require('./email-luna-draft-handoff-contract');
const {
  createEmailLunaDraftPolicyEvidence,
  decideEmailLunaDraftPolicy,
} = require('./email-luna-draft-policy');
const { createEmailLunaGroundedTools } = require('./email-luna-grounded-tools');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;

const FACTS = freeze(['catalog', 'availability', 'policy', 'booking', 'payment']);
const INTENT_REQUIRED_FACTS = freeze({
  catalog_question: freeze(['catalog']),
  availability_question: freeze(['availability']),
  policy_question: freeze(['policy']),
  booking_status_question: freeze(['booking']),
  payment_status_question: freeze(['payment']),
});
const INJECTION = /(?:\bsystem\s*:|\[\s*system\s*\]|\bdeveloper\s+(?:message|instruction)|ignore\s+(?:all\s+)?previous\s+instructions?|override\s+policy|switch\s+tenant|call\s+[a-z_$][\w$]*\s*\(|<\s*\/?\s*system\b|\b(?:location_id|required_facts|send_allowed|draft_ready|low_confidence)\s*=|"(?:authority|policy|low_confidence)"\s*:)/i;
const ES_MARKERS = /\b(hola|gracias|buenos|buenas|reserva|precio|disponibilidad|necesito|por favor|alquiler|pago|tabla|ustedes|nosotros|días|noches|mensaje)\b/gi;
const EN_MARKERS = /\b(hello|hi|thanks|please|booking|price|available|need|message|boards?|lesson)\b/gi;

const SAFE_ACKNOWLEDGMENT = freeze({
  en: 'Hi,\n\nThanks for your message. We’ll review it and get back to you shortly.\n\nWarm regards,\nLuna',
  es: 'Hola,\n\nGracias por tu mensaje. Lo revisaremos y te responderemos en breve.\n\nUn saludo cálido,\nLuna',
});

const AUTHORITY_FIELDS = freeze([
  'client_id', 'location_id', 'location_key', 'conversation_id', 'endpoint_id', 'inbound_message_id',
]);
const CONTENT_FIELDS = freeze([
  'subject', 'body_text', 'quoted_history', 'from_display_name', 'from_address',
]);

function ownData(value, key) {
  try {
    const descriptor = getDescriptor(value, key);
    return descriptor && hasOwn(descriptor, 'value') && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function clip(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function detectEmailDraftLanguage(subject, body) {
  const text = `${typeof subject === 'string' ? subject : ''}\n${typeof body === 'string' ? body : ''}`;
  const es = (text.match(ES_MARKERS) || []).length;
  const en = (text.match(EN_MARKERS) || []).length;
  return es > en ? 'es' : 'en';
}

function hasInjection(content) {
  for (const field of CONTENT_FIELDS) {
    const value = content[field];
    if (typeof value === 'string' && INJECTION.test(value)) return true;
  }
  return false;
}

function safeDraft(language, reason) {
  const lang = language === 'es' ? 'es' : 'en';
  return freeze({
    status: 'draft_ready',
    body: SAFE_ACKNOWLEDGMENT[lang],
    language: lang,
    kind: 'safe_acknowledgment',
    reason,
    send_allowed: false,
    auto_send_allowed: false,
    draft_only: true,
    requires_staff_review: true,
  });
}

function authoredDraft(result) {
  return freeze({
    status: 'draft_ready',
    body: result.body,
    language: result.language === 'es' ? 'es' : 'en',
    kind: 'authored',
    reason: null,
    send_allowed: false,
    auto_send_allowed: false,
    draft_only: true,
    requires_staff_review: true,
  });
}

function snapshotAuthority(authority) {
  if (!authority || typeof authority !== 'object' || isProxy(authority) || Array.isArray(authority)) {
    return null;
  }
  const out = {};
  for (const key of AUTHORITY_FIELDS) {
    const value = ownData(authority, key);
    if (typeof value !== 'string' || !value) return null;
    out[key] = value;
  }
  return out;
}

function snapshotContent(content) {
  if (!content || typeof content !== 'object' || isProxy(content) || Array.isArray(content)) {
    return null;
  }
  return {
    subject: clip(ownData(content, 'subject'), 998),
    body_text: clip(ownData(content, 'body_text'), 64000),
    quoted_history: clip(ownData(content, 'quoted_history'), 64000),
    from_display_name: clip(ownData(content, 'from_display_name'), 998),
    from_address: clip(ownData(content, 'from_address'), 320),
  };
}

function snapshotClassifier(raw, authority, language) {
  if (!raw || typeof raw !== 'object' || isProxy(raw) || Array.isArray(raw)) return null;
  const intent = ownData(raw, 'intent');
  const intentSupport = ownData(raw, 'intent_support');
  const identity = ownData(raw, 'identity');
  const lang = ownData(raw, 'language') === 'es' || ownData(raw, 'language') === 'en'
    ? ownData(raw, 'language')
    : language;
  if (typeof intent !== 'string' || typeof intentSupport !== 'string' || typeof identity !== 'string') {
    return null;
  }
  const requested = ownData(raw, 'requested_location_id');
  const required = ownData(raw, 'required_facts');
  const mapped = Object.prototype.hasOwnProperty.call(INTENT_REQUIRED_FACTS, intent)
    ? INTENT_REQUIRED_FACTS[intent]
    : null;
  let requiredFacts = mapped ? mapped.slice() : null;
  if (Array.isArray(required) && required.length) {
    requiredFacts = required.slice();
  }
  if (!requiredFacts) return null;
  return {
    client_id: authority.client_id,
    location_id: authority.location_id,
    conversation_id: authority.conversation_id,
    endpoint_id: authority.endpoint_id,
    language: lang,
    identity,
    intent,
    intent_support: intentSupport,
    requested_location_id: typeof requested === 'string' && requested ? requested : authority.location_id,
    explicit_human_request: ownData(raw, 'explicit_human_request') === true,
    attachment_interpretation_required: ownData(raw, 'attachment_interpretation_required') === true,
    unsafe_transactional_request: ownData(raw, 'unsafe_transactional_request') === true,
    required_facts: requiredFacts,
  };
}

function pinQueryOwners(queryOwners) {
  if (!queryOwners || typeof queryOwners !== 'object' || isProxy(queryOwners) || Array.isArray(queryOwners)) {
    return null;
  }
  const pinned = {};
  for (const fact of FACTS) {
    const fn = ownData(queryOwners, fact);
    if (typeof fn !== 'function') return null;
    pinned[fact] = fn;
  }
  return pinned;
}

async function collectGroundedResults(tools, requiredFacts) {
  const grounded = {};
  for (const fact of requiredFacts) {
    grounded[fact] = await tools.query(fact, {});
  }
  return grounded;
}

function createEmailLunaDraftOpenPolicyComposition(deps) {
  const classifyIntent = deps && typeof deps.classifyIntent === 'function' ? deps.classifyIntent : null;
  const queryOwners = deps ? pinQueryOwners(deps.queryOwners) : null;
  const createLunaRuntime = deps && typeof deps.createLunaRuntime === 'function'
    ? deps.createLunaRuntime
    : null;

  async function compose(input) {
    const authority = snapshotAuthority(input && input.authority);
    const content = snapshotContent(input && input.untrusted_content);
    if (!authority || !content) return safeDraft('en', 'authority_mismatch');

    let envelope;
    try {
      envelope = createEmailLunaDraftEnvelope({
        authority,
        untrusted_content: content,
      });
    } catch {
      return safeDraft(detectEmailDraftLanguage(content.subject, content.body_text), 'authority_mismatch');
    }

    const language = detectEmailDraftLanguage(content.subject, content.body_text);
    if (hasInjection(content)) return safeDraft(language, 'prompt_injection_detected');
    if (!classifyIntent || !queryOwners || !createLunaRuntime) {
      return safeDraft(language, 'unsupported_intent');
    }

    let classifiedRaw;
    try {
      classifiedRaw = classifyIntent({
        subject: content.subject,
        body_text: content.body_text,
        language,
        authority,
      });
    } catch {
      return safeDraft(language, 'uncertain_intent');
    }
    const classified = snapshotClassifier(classifiedRaw, authority, language);
    if (!classified) return safeDraft(language, 'uncertain_intent');

    let groundedResults;
    try {
      const tools = createEmailLunaGroundedTools({
        authority: { client_id: authority.client_id, location_id: authority.location_id },
        queryOwners,
      });
      groundedResults = await collectGroundedResults(tools, classified.required_facts);
    } catch {
      return safeDraft(classified.language, 'grounded_fact_unavailable');
    }

    let evidence;
    let decision;
    try {
      evidence = createEmailLunaDraftPolicyEvidence({
        client_id: classified.client_id,
        location_id: classified.location_id,
        conversation_id: classified.conversation_id,
        endpoint_id: classified.endpoint_id,
        language: classified.language,
        identity: classified.identity,
        intent: classified.intent,
        intent_support: classified.intent_support,
        requested_location_id: classified.requested_location_id,
        explicit_human_request: classified.explicit_human_request,
        attachment_interpretation_required: classified.attachment_interpretation_required,
        unsafe_transactional_request: classified.unsafe_transactional_request,
        required_facts: classified.required_facts,
        grounded_results: groundedResults,
      });
      decision = decideEmailLunaDraftPolicy({ envelope, evidence });
    } catch {
      return safeDraft(classified.language, 'uncertain_intent');
    }
    if (!decision || decision.status !== 'draft_ready') {
      return safeDraft(classified.language, decision && decision.reason ? decision.reason : 'unsupported_intent');
    }

    try {
      const srcEnv = input && input.env && typeof input.env === 'object' ? input.env : {};
      const runtimeEnv = {
        LUNA_DEPLOYMENT: ownData(srcEnv, 'LUNA_DEPLOYMENT'),
        EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: ownData(srcEnv, 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED'),
      };
      const runtimeConfig = {
        env: runtimeEnv,
        authority: {
          client_id: authority.client_id,
          location_id: authority.location_id,
          location_key: authority.location_key,
        },
        tenant_location_gate: {
          client_id: authority.client_id,
          location_id: authority.location_id,
          location_key: authority.location_key,
          draft_enabled: true,
        },
      };
      if (input && typeof input.callModel === 'function') runtimeConfig.callModel = input.callModel;
      if (input && Number.isSafeInteger(input.timeoutMs)) runtimeConfig.timeoutMs = input.timeoutMs;
      const runtime = createLunaRuntime(runtimeConfig);
      if (!runtime || typeof runtime.authorDraft !== 'function') {
        return safeDraft(classified.language, 'model_provider_error');
      }
      const request = {};
      request.envelope = envelope;
      request.decision = decision;
      request.evidence = evidence;
      const authored = await runtime.authorDraft(request);
      if (authored && ownData(authored, 'status') === 'draft_ready'
          && typeof ownData(authored, 'body') === 'string' && ownData(authored, 'body').trim()
          && ownData(authored, 'draft_only') === true
          && ownData(authored, 'requires_staff_review') === true
          && ownData(authored, 'send_allowed') === false
          && ownData(authored, 'auto_send_allowed') === false
          && ownData(authored, 'client_id') === authority.client_id
          && ownData(authored, 'location_id') === authority.location_id
          && ownData(authored, 'conversation_id') === authority.conversation_id) {
        return authoredDraft(authored);
      }
      return safeDraft(classified.language, authored && authored.reason ? authored.reason : 'unsupported_claim');
    } catch {
      return safeDraft(classified.language, 'model_provider_error');
    }
  }

  return freeze({ compose, detectEmailDraftLanguage });
}

module.exports = freeze({
  SAFE_ACKNOWLEDGMENT,
  INTENT_REQUIRED_FACTS,
  detectEmailDraftLanguage,
  createEmailLunaDraftOpenPolicyComposition,
});
