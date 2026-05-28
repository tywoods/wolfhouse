/**
 * Phase 2f.2 — n8n expression helpers for merged booking/payment paths.
 * Shared nodes must not hard-reference branch-only nodes (Extract Guest Details, Search Hold, etc.).
 */

const RESOLVER_VERSION = '2f.4';

/** n8n expression fragments (include leading ={{ ... }}). */
const expr = {
  guestName:
    "={{ $json.guest_name || $json.fields?.['Guest Name'] || $('Code - Prepare Stripe Payment Context').first().json.guest_name || '' }}",
  guestEmail:
    "={{ $json.guest_email || $json.email || $json.fields?.['Email'] || $('Code - Prepare Stripe Payment Context').first().json.guest_email || '' }}",
  guestPhone:
    "={{ $json.phone || $json.fields?.['Phone'] || $('Code - Prepare Stripe Payment Context').first().json.phone || $('Normalize Incoming Message').first().json.phone || $('Create Inbound Message').first().json.fields?.['Conversation Phone'] || '' }}",
  guestCount:
    "={{ $json.guest_count || $('Code - Prepare Stripe Payment Context').first().json.guest_count || 1 }}",
  requestedRoomType:
    "={{ $json.requested_room_type || $('Code - Prepare Stripe Payment Context').first().json.requested_room_type || $('Merge Session State').first().json.session?.room_type || 'shared' }}",
  roomPreference:
    "={{ $json.room_preference || $('Code - Prepare Stripe Payment Context').first().json.room_preference || $('Merge Session State').first().json.session?.room_preference || 'shared' }}",
  guestGenderGroup:
    "={{ $json.guest_gender_group_type || $('Code - Prepare Stripe Payment Context').first().json.guest_gender_group_type || 'unknown' }}",
  paymentLink:
    "={{ $json.payment_link || $json.checkout_url || ($('Update Booking - Stripe Payment Link').isExecuted ? $('Update Booking - Stripe Payment Link').first().json.fields?.['Payment Link'] : '') || $('Code - Prepare Stripe Payment Context').first().json.payment_link || '' }}",
  holdBookingId: `={{ (() => {
    const fromJson = $json.booking_code || '';
    const fromCtx =
      $('Code - Prepare Stripe Payment Context').first().json.booking_code ||
      $('Code - Prepare Stripe Payment Context').first().json.current_hold_booking_code ||
      '';
    const fromUpdatedHold = $('Update Hold With Guest Details').isExecuted
      ? (
          $('Update Hold With Guest Details').first().json.fields?.['Booking ID'] ||
          $('Update Hold With Guest Details').first().json['Booking ID'] ||
          ''
        )
      : '';
    const fromSearchHold = $('Search Hold With Guest Details').isExecuted
      ? (
          $('Search Hold With Guest Details').first().json.fields?.['Booking ID'] ||
          $('Search Hold With Guest Details').first().json['Booking ID'] ||
          ''
        )
      : '';
    const fromActiveBooking = $('Code - Pick Active Booking').isExecuted
      ? (
          $('Code - Pick Active Booking').first().json.active_booking?.fields?.['Booking ID'] ||
          $('Code - Pick Active Booking').first().json.active_booking?.booking_id ||
          $('Code - Pick Active Booking').first().json.active_booking_id ||
          ''
        )
      : '';
    const fromConversation =
      $('Search Conversation').first().json.fields?.['Current Hold ID'] || '';
    const fromSession =
      $('Merge Session State').first().json.session?.current_hold_booking_code ||
      $('Merge Session State').first().json.session?.hold_booking_id ||
      $('Merge Session State').first().json.session?.current_hold_id ||
      '';
    const fromCreateHold = $('Create Booking Hold').isExecuted
      ? (
          $('Create Booking Hold').first().json.fields?.['Booking ID'] ||
          $('Create Booking Hold').first().json['Booking ID'] ||
          ''
        )
      : '';

    const candidates = [
      fromJson,
      fromCtx,
      fromUpdatedHold,
      fromSearchHold,
      fromActiveBooking,
      fromConversation,
      fromSession,
      fromCreateHold,
    ]
      .map((value) => String(value || '').trim())
      .filter((value) => value && value !== 'null' && value !== 'undefined');

    const whCode = candidates.find((value) => /^WH-/i.test(value));
    return whCode || candidates[0] || '';
  })() }}`,
  language:
    "={{ $('Code - Parse Route').first().json.language || $('Search Conversation').first().json.fields?.Language || 'en' }}",
  lastGuestMessage:
    "={{ $('Normalize Incoming Message').first().json.guest_message || $('Create Inbound Message').first().json.fields?.['Message Text'] || '' }}",
  lastBotReplyPayment:
    "={{ $('Create Outbound Message - Payment Pending').first().json.fields?.['Message Text'] || $('Code - Guard Payment Pending WhatsApp').first().json.guarded_message_text || '' }}",
  pendingActionPayment:
    "={{ $('Code - Build Rooming Question').isExecuted && $('Code - Build Rooming Question').first().json.should_ask_rooming_question ? 'rooming_info_needed' : 'none' }}",
};

const ASSEMBLE_PAYMENT_PENDING_REPLY_JS = `function safeNodeJson(nodeName) {
  try {
    return $(nodeName).first().json || {};
  } catch (_) {
    return {};
  }
}

function getCanonicalCheckoutUrl() {
  const sessionCall = safeNodeJson('Code - Call Create Payment Session');
  if (sessionCall.checkout_url && String(sessionCall.checkout_url).trim()) {
    return String(sessionCall.checkout_url).trim();
  }

  const stripeUpdate = safeNodeJson('Update Booking - Stripe Payment Link');
  const fromAirtable = stripeUpdate.fields?.['Payment Link'];
  if (fromAirtable && String(fromAirtable).trim()) {
    return String(fromAirtable).trim();
  }

  const ctx = safeNodeJson('Code - Prepare Stripe Payment Context');
  const fromCtx = ctx.payment_link || ctx.checkout_url;
  if (fromCtx && String(fromCtx).trim()) {
    return String(fromCtx).trim();
  }

  return '';
}

function stripUrls(text) {
  return String(text || '')
    .replace(/https?:\\/\\/[^\\s]+/gi, '')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
}

function getLlmBody() {
  const reply = safeNodeJson('Reply - Payment Pending');
  const raw =
    reply.text || reply.output || reply.response || reply.message || '';
  if (String(raw).trim()) {
    return String(raw).trim();
  }

  const fb = safeNodeJson('Code - Stripe Payment Fallback Reply');
  return String(fb.text || fb.reply_text || fb.message || '').trim();
}

function getRoomingQuestionText() {
  const rooming = safeNodeJson('Code - Build Rooming Question');
  if (!rooming.should_ask_rooming_question) {
    return '';
  }
  return String(rooming.rooming_question || '').trim();
}

function stripRoomingFromBody(text) {
  const q = getRoomingQuestionText();
  let body = String(text || '').trim();
  if (!q || !body) {
    return body;
  }
  const escaped = q.replace(/[.*+?^\\$\{\}()|[\\]\\\\]/g, '\\\\$&');
  body = body.replace(new RegExp(escaped, 'gi'), '');
  body = body.replace(/\\n{3,}/g, '\\n\\n').trim();
  return body;
}

function appendRoomingOnce(text) {
  const q = getRoomingQuestionText();
  const base = String(text || '').trim();
  if (!q) {
    return base;
  }
  if (base.includes(q)) {
    return base;
  }
  return base + '\\n\\n' + q;
}

function impliesPaymentWithoutUrl(text) {
  return /\\b(complete\\s+(the\\s+)?payment|payment\\s+below|pay\\s+below|pay\\s+here|lock\\s+it\\s+in|secure\\s+your\\s+booking|to\\s+confirm\\s+your\\s+booking)\\b/i.test(
    String(text || '')
  );
}

function buildNoUrlSafeTemplate(lang, name) {
  const n = name ? ' ' + name : '';
  const byLang = {
    en:
      'Thanks' +
      n +
      "! Your space is held for 1 hour. We're preparing your secure Stripe payment link and will send it here in a moment.",
    de:
      'Danke' +
      n +
      '! Wir haben euren Platz fuer 1 Stunde reserviert. Wir bereiten gerade euren sicheren Stripe-Zahlungslink vor und schicken ihn gleich hier.',
    es:
      'Gracias' +
      n +
      '! Hemos reservado vuestro espacio durante 1 hora. Estamos preparando vuestro enlace de pago seguro de Stripe y lo enviaremos aqui en un momento.',
    it:
      'Grazie' +
      n +
      '! Abbiamo tenuto il posto per 1 ora. Stiamo preparando il link di pagamento Stripe sicuro e ve lo inviamo qui tra un attimo.',
  };
  return byLang[lang] || byLang.en;
}

function buildTemplateWithUrl(canonicalUrl, lang, name) {
  const n = name ? ' ' + name : '';
  const byLang = {
    en:
      'Thanks' +
      n +
      '! Your space is held for 1 hour. Pay here to confirm your booking (EUR 200 deposit):\\n' +
      canonicalUrl,
    de:
      'Danke' +
      n +
      '! Wir haben euren Platz fuer 1 Stunde reserviert. Hier bezahlen (200 EUR Anzahlung):\\n' +
      canonicalUrl,
    es:
      'Gracias' +
      n +
      '! Hemos reservado vuestro espacio durante 1 hora. Pagar aqui (deposito 200 EUR):\\n' +
      canonicalUrl,
    it:
      'Grazie' +
      n +
      '! Abbiamo tenuto il posto per 1 ora. Paga qui (caparra 200 EUR):\\n' +
      canonicalUrl,
  };
  return byLang[lang] || byLang.en;
}

const canonicalUrl = getCanonicalCheckoutUrl();
const useStripe =
  String($env.USE_STRIPE_CHECKOUT || 'true').toLowerCase() === 'true';
const lang = String(
  $('Code - Parse Route').first().json.language ||
    $('Search Conversation').first().json.fields?.Language ||
    'en'
).toLowerCase();
const name =
  safeNodeJson('Code - Prepare Stripe Payment Context').guest_name ||
  $('Merge Session State').first().json.session?.name ||
  '';

let llmBody = stripRoomingFromBody(stripUrls(getLlmBody()));
let finalText = '';
let assemblyMode = 'no_url';

const stripeUrlReady =
  canonicalUrl &&
  useStripe &&
  !canonicalUrl.includes('booking-payment-placeholder');

if (useStripe && !stripeUrlReady && impliesPaymentWithoutUrl(llmBody)) {
  llmBody = '';
  assemblyMode = 'payment_teaser_stripped';
}

if (stripeUrlReady) {
  if (llmBody) {
    finalText = appendRoomingOnce(llmBody + '\\n\\n' + canonicalUrl);
    assemblyMode = 'llm_plus_exact_url';
  } else {
    finalText = appendRoomingOnce(buildTemplateWithUrl(canonicalUrl, lang, name));
    assemblyMode = 'template_exact_url';
  }
} else if (useStripe) {
  finalText = appendRoomingOnce(buildNoUrlSafeTemplate(lang, name));
  assemblyMode = llmBody ? 'safe_no_url_with_rooming' : 'safe_no_url_template';
} else if (llmBody) {
  finalText = appendRoomingOnce(llmBody);
  assemblyMode = 'llm_only';
} else {
  finalText = appendRoomingOnce(
    'Thanks! Your space is held for 1 hour. Our team will send your payment link here shortly.'
  );
  assemblyMode = 'no_link_fallback';
}

return [
  {
    json: {
      reply_text: finalText,
      text: finalText,
      message: finalText,
      expected_checkout_url: canonicalUrl,
      assembly_mode: assemblyMode,
      stripe_url_ready: stripeUrlReady,
    },
  },
];`;

const GUARD_PAYMENT_PENDING_WHATSAPP_JS = `function safeNodeJson(nodeName) {
  try {
    return $(nodeName).first().json || {};
  } catch (_) {
    return {};
  }
}

function getCanonicalCheckoutUrl() {
  const assemble = safeNodeJson('Code - Assemble Payment Pending Reply');
  if (assemble.expected_checkout_url && String(assemble.expected_checkout_url).trim()) {
    return String(assemble.expected_checkout_url).trim();
  }

  const sessionCall = safeNodeJson('Code - Call Create Payment Session');
  if (sessionCall.checkout_url && String(sessionCall.checkout_url).trim()) {
    return String(sessionCall.checkout_url).trim();
  }

  const stripeUpdate = safeNodeJson('Update Booking - Stripe Payment Link');
  const fromAirtable = stripeUpdate.fields?.['Payment Link'];
  if (fromAirtable && String(fromAirtable).trim()) {
    return String(fromAirtable).trim();
  }

  const ctx = safeNodeJson('Code - Prepare Stripe Payment Context');
  const fromCtx = ctx.payment_link || ctx.checkout_url;
  if (fromCtx && String(fromCtx).trim()) {
    return String(fromCtx).trim();
  }

  return '';
}

function extractStripeCheckoutUrl(text) {
  const match = String(text || '').match(
    /https:\\/\\/checkout\\.stripe\\.com\\/[A-Za-z0-9_\\-%.~/?#=&+]+/i
  );
  if (!match) {
    return '';
  }
  return match[0].replace(/[)\\].,!?]+$/, '');
}

function getRoomingQuestionText() {
  const rooming = safeNodeJson('Code - Build Rooming Question');
  if (!rooming.should_ask_rooming_question) {
    return '';
  }
  return String(rooming.rooming_question || '').trim();
}

function stripRoomingFromBody(text) {
  const q = getRoomingQuestionText();
  let body = String(text || '').trim();
  if (!q || !body) {
    return body;
  }
  const escaped = q.replace(/[.*+?^\\$\{\}()|[\\]\\\\]/g, '\\\\$&');
  body = body.replace(new RegExp(escaped, 'gi'), '');
  body = body.replace(/\\n{3,}/g, '\\n\\n').trim();
  return body;
}

function appendRoomingOnce(text) {
  const q = getRoomingQuestionText();
  const base = String(text || '').trim();
  if (!q) {
    return base;
  }
  if (base.includes(q)) {
    return base;
  }
  return base + '\\n\\n' + q;
}

function impliesPaymentWithoutUrl(text) {
  return /\\b(complete\\s+(the\\s+)?payment|payment\\s+below|pay\\s+below|pay\\s+here|lock\\s+it\\s+in|secure\\s+your\\s+booking|to\\s+confirm\\s+your\\s+booking)\\b/i.test(
    String(text || '')
  );
}

function buildNoUrlSafeTemplate(lang, name) {
  const n = name ? ' ' + name : '';
  const byLang = {
    en:
      'Thanks' +
      n +
      "! Your space is held for 1 hour. We're preparing your secure Stripe payment link and will send it here in a moment.",
    de:
      'Danke' +
      n +
      '! Wir haben euren Platz fuer 1 Stunde reserviert. Wir bereiten gerade euren sicheren Stripe-Zahlungslink vor und schicken ihn gleich hier.',
    es:
      'Gracias' +
      n +
      '! Hemos reservado vuestro espacio durante 1 hora. Estamos preparando vuestro enlace de pago seguro de Stripe y lo enviaremos aqui en un momento.',
    it:
      'Grazie' +
      n +
      '! Abbiamo tenuto il posto per 1 ora. Stiamo preparando il link di pagamento Stripe sicuro e ve lo inviamo qui tra un attimo.',
  };
  return byLang[lang] || byLang.en;
}

function buildGuardTemplate(canonicalUrl, lang, name) {
  const n = name ? ' ' + name : '';
  const byLang = {
    en:
      'Thanks' +
      n +
      '! Your space is held for 1 hour. Pay here to confirm your booking (EUR 200 deposit):\\n' +
      canonicalUrl,
    de:
      'Danke' +
      n +
      '! Wir haben euren Platz fuer 1 Stunde reserviert. Hier bezahlen (200 EUR Anzahlung):\\n' +
      canonicalUrl,
    es:
      'Gracias' +
      n +
      '! Hemos reservado vuestro espacio durante 1 hora. Pagar aqui (deposito 200 EUR):\\n' +
      canonicalUrl,
    it:
      'Grazie' +
      n +
      '! Abbiamo tenuto il posto per 1 ora. Paga qui (caparra 200 EUR):\\n' +
      canonicalUrl,
  };
  return byLang[lang] || byLang.en;
}

const assembleInput = $input.first()?.json || {};
const assemble = {
  ...safeNodeJson('Code - Assemble Payment Pending Reply'),
  ...assembleInput,
};
const messageText = String(
  assembleInput.reply_text || assembleInput.text || assemble.reply_text || ''
).trim();
const expected = getCanonicalCheckoutUrl();
const useStripe =
  String($env.USE_STRIPE_CHECKOUT || 'true').toLowerCase() === 'true';
const lang = String(
  $('Code - Parse Route').first().json.language ||
    $('Search Conversation').first().json.fields?.Language ||
    'en'
).toLowerCase();
const name =
  safeNodeJson('Code - Prepare Stripe Payment Context').guest_name ||
  $('Merge Session State').first().json.session?.name ||
  '';

let guardedMessageText = messageText || assemble.reply_text || '';
let urlGuardTriggered = false;
let urlGuardReason = 'ok';

const stripeUrlRequired =
  expected &&
  useStripe &&
  !expected.includes('booking-payment-placeholder');

if (stripeUrlRequired) {
  const found = extractStripeCheckoutUrl(guardedMessageText);
  if (found !== expected) {
    urlGuardTriggered = true;
    urlGuardReason = found ? 'url_mismatch_replaced' : 'url_missing_replaced';
    guardedMessageText = appendRoomingOnce(buildGuardTemplate(expected, lang, name));
  }
}

if (stripeUrlRequired && guardedMessageText.includes('booking-payment-placeholder')) {
  urlGuardTriggered = true;
  urlGuardReason = 'placeholder_blocked';
  guardedMessageText = appendRoomingOnce(buildGuardTemplate(expected, lang, name));
}

if (
  useStripe &&
  !stripeUrlRequired &&
  impliesPaymentWithoutUrl(guardedMessageText)
) {
  urlGuardTriggered = true;
  urlGuardReason = 'payment_promised_without_url';
  guardedMessageText = appendRoomingOnce(buildNoUrlSafeTemplate(lang, name));
}

guardedMessageText = stripRoomingFromBody(guardedMessageText);
guardedMessageText = appendRoomingOnce(guardedMessageText);

return [
  {
    json: {
      guarded_message_text: guardedMessageText,
      expected_checkout_url: expected,
      extracted_checkout_url: extractStripeCheckoutUrl(guardedMessageText),
      url_guard_triggered: urlGuardTriggered,
      url_guard_reason: urlGuardReason,
      send_allowed:
        !stripeUrlRequired ||
        extractStripeCheckoutUrl(guardedMessageText) === expected,
    },
  },
];`;

const SUMMARIZE_PAYMENT_PENDING_JS = `function safeNodeJson(nodeName) {
  try {
    return $(nodeName).first().json || {};
  } catch (_) {
    return {};
  }
}

const ctx = safeNodeJson('Code - Prepare Stripe Payment Context');
const extracted = safeNodeJson('Code - Extract Guest Details');
const inputJson = $input.first()?.json || {};

return [
  {
    json: {
      guest_name: inputJson.guest_name || ctx.guest_name || extracted.guest_name || '',
      guest_email: inputJson.guest_email || inputJson.email || ctx.guest_email || extracted.guest_email || '',
      guest_phone: inputJson.guest_phone || inputJson.phone || ctx.phone || extracted.guest_phone || '',
      guest_count: Number(inputJson.guest_count || ctx.guest_count || 1),
      requested_room_type: inputJson.requested_room_type || ctx.requested_room_type || 'shared',
      room_preference: inputJson.room_preference || ctx.room_preference || 'shared',
      guest_gender_group_type:
        inputJson.guest_gender_group_type || ctx.guest_gender_group_type || 'unknown',
      payment_link: inputJson.payment_link || ctx.payment_link || '',
      booking_code: inputJson.booking_code || ctx.booking_code || '',
      checkout_url: inputJson.checkout_url || ctx.payment_link || '',
      updated_hold_count: $input.all().length,
    },
  },
];`;

const AI_CLASSIFY_ROOMING_LEAD_BLOCK = `Lead guest name:
{{ $json.guest_name || $('Code - Prepare Stripe Payment Context').first().json.guest_name || '' }}

Guest count:
{{ $json.guest_count || $('Code - Prepare Stripe Payment Context').first().json.guest_count || 1 }}

Requested room type:
{{ $json.requested_room_type || $('Code - Prepare Stripe Payment Context').first().json.requested_room_type || 'shared' }}

Existing guest gender/group type:
{{ $json.guest_gender_group_type || $('Code - Prepare Stripe Payment Context').first().json.guest_gender_group_type || 'unknown' }}

Existing room preference:
{{ $json.room_preference || $('Code - Prepare Stripe Payment Context').first().json.room_preference || 'unknown' }}`;

function patchAiClassifyRoomingPrompt(text) {
  if (!text || !text.includes('Search Hold With Guest Details')) {
    return text;
  }

  const start = text.indexOf('Lead guest name:');
  const rules = text.indexOf('\n\nRules:');
  if (start === -1 || rules === -1) {
    return text;
  }

  return text.slice(0, start) + AI_CLASSIFY_ROOMING_LEAD_BLOCK + text.slice(rules);
}

function patchPaymentPendingLlmPromptNoUrl(text) {
  if (!text) return text;

  let next = text;
  next = next.replace(/\n\nPayment link:\n\{\{[\s\S]*?\}\}\n\n/g, '\n\n');
  next = next.replace(/\* Include the payment link\.\n/g, '');
  next = next.replace(
    /\* If Payment link is empty, do not include a URL\. Say the team will follow up with payment details shortly\. Do not use a placeholder link\.\n/g,
    '* NEVER include any URL, http, https, or payment link text. The system appends the exact Stripe Checkout URL after your message.\n'
  );
  next = next.replace(
    /\* If the real payment link is missing, use the provided fallback payment link\.\n/g,
    '* NEVER include any URL, http, https, or payment link text. The system appends the exact Stripe Checkout URL after your message.\n'
  );
  next = next.replace(
    /\* Do not let any rooming question delay or replace the payment link\.\n/g,
    '* Do not let any rooming question replace payment instructions (link is appended separately).\n'
  );
  next = next.replace(
    /\* If a rooming question is allowed, include it at the end after the payment link\.\n/g,
    '* Never include any rooming/gender/group question; the system appends it once after the payment link if needed.\n'
  );
  next = next.replace(
    /\* If a rooming question is allowed, include it at the end of your message \(before the system adds the payment link\)\.\n/g,
    '* Never include any rooming/gender/group question; the system appends it once after the payment link if needed.\n'
  );
  next = next.replace(
    /Rooming question:\n\{\{ \$json\.guest_name[\s\S]*?rooming_question : '' \}\}\n\n/g,
    'Rooming question:\n(do not include — appended once by the system after the payment link if needed)\n\n'
  );
  next = next.replace(
    /Rooming question:\n\{\{ \$\('Code - Build Rooming Question'\)[^}]+\}\}\n\n/g,
    'Rooming question:\n(do not include — appended once by the system after the payment link if needed)\n\n'
  );
  next = next.replace(
    /\* If the booking is private, end naturally after the payment\/confirmation sentence\.\n/g,
    '* If the booking is private, end naturally after noting payment will complete the booking.\n'
  );
  next = next.replace(
    /\* If a rooming question is allowed, include it at the end after the payment link\.\n\* If a rooming question is not allowed, do not mention rooming, gender, girls, guys, mixed, or placement\.\n/g,
    '* Never include any rooming/gender/group question in your reply (the system appends it once after the payment link if needed).\n* Do not mention rooming, gender, girls, guys, mixed, or placement.\n'
  );

  return next;
}

function patchReplyPaymentPendingPrompt(text) {
  if (!text) return text;

  let next = patchPaymentPendingLlmPromptNoUrl(text);

  next = next.replace(
    /\{\{ \$json\.guest_name \|\| \$\('Code - Extract Guest Details'\)[^}]+\}\}/g,
    '{{ $json.guest_name || $(\'Code - Prepare Stripe Payment Context\').first().json.guest_name || \'\' }}'
  );
  next = next.replace(
    /\{\{ \$json\.guest_email \|\| \$\('Code - Extract Guest Details'\)[^}]+\}\}/g,
    '{{ $json.guest_email || $(\'Code - Prepare Stripe Payment Context\').first().json.guest_email || \'\' }}'
  );

  const roomTypeLegacy =
    "{{ $('Search Hold With Guest Details').first().json.fields?.['Requested Room Type'] || $('Update Hold With Guest Details').first().json.fields?.['Requested Room Type'] || $('Merge Session State').first().json.session?.room_type || 'shared' }}";
  const roomPrefLegacy =
    "{{ $('Search Hold With Guest Details').first().json.fields?.['Room Preference'] || $('Update Hold With Guest Details').first().json.fields?.['Room Preference'] || $('Merge Session State').first().json.session?.room_preference || 'shared' }}";
  const genderLegacy =
    "{{ $('Search Hold With Guest Details').first().json.fields?.['Guest Gender / Group Type'] || $('Update Hold With Guest Details').first().json.fields?.['Guest Gender / Group Type'] || $('Merge Session State').first().json.session?.guest_gender_group_type || 'unknown' }}";

  const roomTypeMerged =
    '{{ $json.requested_room_type || $(\'Code - Prepare Stripe Payment Context\').first().json.requested_room_type || $(\'Merge Session State\').first().json.session?.room_type || \'shared\' }}';
  const roomPrefMerged =
    '{{ $json.room_preference || $(\'Code - Prepare Stripe Payment Context\').first().json.room_preference || $(\'Merge Session State\').first().json.session?.room_preference || \'shared\' }}';
  const genderMerged =
    '{{ $json.guest_gender_group_type || $(\'Code - Prepare Stripe Payment Context\').first().json.guest_gender_group_type || \'unknown\' }}';

  next = next.split(roomTypeLegacy).join(roomTypeMerged);
  next = next.split(roomPrefLegacy).join(roomPrefMerged);
  next = next.split(genderLegacy).join(genderMerged);

  return next;
}

function applyMergedPaymentPathFixes(workflow) {
  const summarize = workflow.nodes.find((n) => n.name === 'Code - Summarize Payment Pending');
  const aiRooming = workflow.nodes.find((n) => n.name === 'AI - Classify Rooming Info');
  const replyPayment = workflow.nodes.find((n) => n.name === 'Reply - Payment Pending');
  const updateConvoGuest = workflow.nodes.find((n) => n.name === 'Update Conversation - Guest Details');
  const upsertConvoPayment = workflow.nodes.find(
    (n) => n.name === 'Create/update Conversation - Payment Pending'
  );

  if (summarize) {
    summarize.parameters.jsCode = SUMMARIZE_PAYMENT_PENDING_JS;
  }

  if (aiRooming?.parameters?.text) {
    aiRooming.parameters.text = patchAiClassifyRoomingPrompt(aiRooming.parameters.text);
  }

  if (replyPayment?.parameters?.text) {
    replyPayment.parameters.text = patchReplyPaymentPendingPrompt(replyPayment.parameters.text);
  }

  if (updateConvoGuest) {
    if (!updateConvoGuest.parameters.columns) {
      updateConvoGuest.parameters.columns = {};
    }
    updateConvoGuest.parameters.columns.mappingMode = 'defineBelow';
    updateConvoGuest.parameters.columns.value = {
      'Needs Human': false,
      'Send Staff Reply': false,
      'Return To Bot': false,
      Phone: expr.guestPhone,
      'Guest Name': expr.guestName,
      Email: expr.guestEmail,
      Language: expr.language,
      'Last Message': expr.lastGuestMessage,
      'Conversation Stage': 'payment_pending',
      'Pending Action': expr.pendingActionPayment,
      'Bot Mode': 'bot_active',
      'Current Hold ID': expr.holdBookingId,
    };
    updateConvoGuest.parameters.columns.matchingColumns = ['Phone'];
  }

  if (upsertConvoPayment) {
    if (!upsertConvoPayment.parameters.columns) {
      upsertConvoPayment.parameters.columns = {};
    }
    upsertConvoPayment.parameters.columns.mappingMode = 'defineBelow';
    upsertConvoPayment.parameters.columns.value = {
      'Needs Human': false,
      'Send Staff Reply': false,
      'Return To Bot': false,
      Phone: expr.guestPhone,
      Language: expr.language,
      'Last Message': expr.lastGuestMessage,
      'Last Bot Reply': expr.lastBotReplyPayment,
      Status: 'Open',
      'Conversation Stage': 'payment_pending',
      Email: expr.guestEmail,
      'Pending Action': expr.pendingActionPayment,
      'Bot Mode': 'bot_active',
      'Guest Name': expr.guestName,
      'Current Hold ID': expr.holdBookingId,
      'Chat Transcript':
        "={{ (   $('Update Conversation - Append Guest Message').first().json.fields?.['Chat Transcript'] ||   '' ) + '\\n\\n**💁 Booking Assistant · ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '**\\n' + (   $('Create Outbound Message - Payment Pending').first().json.fields?.['Message Text'] || $('Code - Guard Payment Pending WhatsApp').first().json.guarded_message_text ||   '' ) }}",
    };
    upsertConvoPayment.parameters.columns.matchingColumns = ['Phone'];
  }
}

function applyDeterministicPaymentUrl(workflow) {
  const assembleName = 'Code - Assemble Payment Pending Reply';
  const guardName = 'Code - Guard Payment Pending WhatsApp';

  let assembleNode = workflow.nodes.find((n) => n.name === assembleName);
  if (!assembleNode) {
    assembleNode = {
      parameters: { jsCode: ASSEMBLE_PAYMENT_PENDING_REPLY_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [3920, 368],
      id: '2f030001-0001-4000-8000-000000000301',
      name: assembleName,
    };
    workflow.nodes.push(assembleNode);
  } else {
    assembleNode.parameters.jsCode = ASSEMBLE_PAYMENT_PENDING_REPLY_JS;
  }

  let guardNode = workflow.nodes.find((n) => n.name === guardName);
  if (!guardNode) {
    guardNode = {
      parameters: { jsCode: GUARD_PAYMENT_PENDING_WHATSAPP_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [4144, 352],
      id: '2f030002-0002-4000-8000-000000000302',
      name: guardName,
    };
    workflow.nodes.push(guardNode);
  } else {
    guardNode.parameters.jsCode = GUARD_PAYMENT_PENDING_WHATSAPP_JS;
  }

  const sticky = workflow.nodes.find((n) => n.name === 'Sticky Note - Phase 2f.3 Payment URL');
  if (!sticky) {
    workflow.nodes.push({
      parameters: {
        content:
          '## Phase 2f.3 - Exact Stripe URL\n\nAssemble → Guard → Outbound → WhatsApp. LLM never outputs URLs; Guard validates URL before Airtable outbound + send.',
        height: 160,
        width: 400,
      },
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [3840, 200],
      id: '2f030003-0003-4000-8000-000000000303',
      name: 'Sticky Note - Phase 2f.3 Payment URL',
    });
  }

  workflow.connections['Reply - Payment Pending'] = {
    main: [[{ node: assembleName, type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Stripe Payment Fallback Reply'] = {
    main: [[{ node: assembleName, type: 'main', index: 0 }]],
  };

  workflow.connections[assembleName] = {
    main: [[{ node: guardName, type: 'main', index: 0 }]],
  };

  workflow.connections[guardName] = {
    main: [[{ node: 'Create Outbound Message - Payment Pending', type: 'main', index: 0 }]],
  };

  workflow.connections['Create Outbound Message - Payment Pending'] = {
    main: [[{ node: 'Send WhatsApp Reply - Payment Pending', type: 'main', index: 0 }]],
  };

  const outboundPayment = workflow.nodes.find((n) => n.name === 'Create Outbound Message - Payment Pending');
  if (outboundPayment?.parameters?.columns?.value) {
    outboundPayment.parameters.columns.value['Message Text'] =
      '={{ $json.guarded_message_text || "" }}';
  }

  const sendWa = workflow.nodes.find((n) => n.name === 'Send WhatsApp Reply - Payment Pending');
  if (sendWa?.parameters?.jsonBody) {
    const outboundMsgExpr =
      "$('Create Outbound Message - Payment Pending').first().json.fields['Message Text']";
    sendWa.parameters.jsonBody = sendWa.parameters.jsonBody
      .replace(
        "$('Code - Guard Payment Pending WhatsApp').first().json.guarded_message_text",
        outboundMsgExpr
      )
      .replace(
        "body: $('Code - Guard Payment Pending WhatsApp').first().json.guarded_message_text || ''",
        `body: ${outboundMsgExpr} || ''`
      );
    if (!sendWa.parameters.jsonBody.includes('Create Outbound Message - Payment Pending')) {
      sendWa.parameters.jsonBody = sendWa.parameters.jsonBody.replace(
        /body:\s*\$\([^)]+\)\.first\(\)\.json\.[^}]+\}\s*\|\|\s*''/,
        `body: ${outboundMsgExpr} || ''`
      );
    }
  }

  // Guard runs before outbound; n8n positions left-to-right along the chain.
  if (assembleNode.position) {
    guardNode.position = [assembleNode.position[0] + 224, assembleNode.position[1]];
  }
  if (guardNode.position && outboundPayment?.position) {
    outboundPayment.position = [guardNode.position[0] + 224, guardNode.position[1]];
  }
  if (outboundPayment?.position && sendWa?.position) {
    sendWa.position = [outboundPayment.position[0] + 208, outboundPayment.position[1]];
  }

}

module.exports = {
  RESOLVER_VERSION,
  expr,
  SUMMARIZE_PAYMENT_PENDING_JS,
  ASSEMBLE_PAYMENT_PENDING_REPLY_JS,
  GUARD_PAYMENT_PENDING_WHATSAPP_JS,
  applyMergedPaymentPathFixes,
  applyDeterministicPaymentUrl,
  patchAiClassifyRoomingPrompt,
  patchReplyPaymentPendingPrompt,
  patchPaymentPendingLlmPromptNoUrl,
};
