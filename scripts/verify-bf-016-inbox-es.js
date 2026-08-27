#!/usr/bin/env node
'use strict';

/**
 * BF-016-INBOX-ES — Spanish portal Inbox thread first paint + canned draft locale.
 *
 * Proves:
 *   - buildConvDetailSkeleton and nearby composer chrome (Approve & send,
 *     Create Draft, Context, Subject) paint locale copy on first HTML
 *     construction. locale=es is already Spanish; locale=en stays English.
 *     No English first paint that is translated later via data-i18n.
 *   - Safe/canned Create Draft / draft-open fallback is locale-correct from
 *     the real policy composition owner (not a test rewrite). Staff notes
 *     are not pasted. The forbidden wrap phrase is not restored.
 *
 * Stay off: auto-send, IMAP/SMTP, booking create, MAIL-MVP-004/005/006,
 * production, Azure, gateway, /sethome, mailbox mutation.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const POLICY = path.join(ROOT, 'scripts/lib/email-luna-draft-open-policy-composition.js');
const OPEN = path.join(ROOT, 'scripts/lib/staff-email-luna-draft-open.js');
const NATURAL = path.join(ROOT, 'scripts/lib/email-luna-create-draft-natural-author.js');

const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const {
  SAFE_ACKNOWLEDGMENT,
  detectEmailDraftLanguage,
  createEmailLunaDraftOpenPolicyComposition,
} = require('./lib/email-luna-draft-open-policy-composition');
const {
  createEmailLunaSunsetStagingRuntimeComposition,
} = require('./lib/email-luna-sunset-staging-runtime-composition');
const {
  renderCreateDraftNaturalPlan,
} = require('./lib/email-luna-create-draft-natural-author');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const M = '66666666-6666-4666-8666-666666666666';

const LIVE_NOTES = 'Thank them for the msg and then ask them if they want to do a booking';
const FORBIDDEN_WRAP = /we also wanted to add|tambi[eé]n quer[ií]amos a[nñ]adir/i;
const STAFF_VOICE = /staff notes|staff instruction|operator context|\bthank them\b|\bask them\b|\btell them\b/i;

const ES_THREAD = {
  subject: 'Re: clases',
  body_text: 'Quiero reservar dos tablas para el sábado',
};
const ES_ACCENT_THREAD = {
  subject: 'Consulta',
  body_text: 'Me gustaría información sobre el próximo curso',
};
const EN_THREAD = {
  subject: 'Re: Testing 8 26',
  body_text: 'Hi, just testing the front desk mailbox.',
};

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tFor(locale) {
  const pack = STAFF_PORTAL_STRINGS[locale] || {};
  const en = STAFF_PORTAL_STRINGS.en || {};
  return function t(key) {
    if (pack[key] != null) return pack[key];
    if (en[key] != null) return en[key];
    return key;
  };
}

function loadChrome(src, locale) {
  const t = tFor(locale);
  const sandbox = {
    t,
    portalT: t,
    escHtml,
    staffEmailLunaDraftUiEnabled: () => true,
    staffEmailOutboundUiEnabled: () => true,
    isAuthoritativeEmailConversation: () => true,
  };
  vm.createContext(sandbox);
  const needed = [
    'inboxT',
    'buildConvDetailSkeleton',
    'inboxEmailComposerChromeHtml',
  ].map((name) => sliceFn(src, name)).join('\n');
  vm.runInContext(
    `${needed}\n` +
    'this.buildConvDetailSkeleton = (typeof buildConvDetailSkeleton === "function") ? buildConvDetailSkeleton : null;\n' +
    'this.inboxEmailComposerChromeHtml = (typeof inboxEmailComposerChromeHtml === "function") ? inboxEmailComposerChromeHtml : null;\n' +
    'this.inboxT = (typeof inboxT === "function") ? inboxT : null;\n',
    sandbox,
  );
  return sandbox;
}

function authority() {
  return Object.freeze({
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    conversation_id: V,
    endpoint_id: E,
    inbound_message_id: M,
  });
}

function content(patch) {
  return Object.freeze(Object.assign({
    subject: '',
    body_text: '',
    quoted_history: '',
    from_display_name: 'Guest',
    from_address: 'guest@example.test',
  }, patch));
}

function env() {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
  };
}

function policyFor(callModel) {
  return createEmailLunaDraftOpenPolicyComposition({
    createLunaRuntime: (config) => createEmailLunaSunsetStagingRuntimeComposition({
      ...config,
      callModel: config.callModel || callModel,
    }),
  });
}

function assertNoForbiddenGuestCopy(body, notes) {
  assert.equal(typeof body, 'string');
  assert.doesNotMatch(body, FORBIDDEN_WRAP);
  assert.doesNotMatch(body, STAFF_VOICE);
  assert.equal(body.includes(notes), false);
}

async function main() {
  console.log('verify-bf-016-inbox-es — first-paint ES chrome + locale-correct canned draft\n');

  const threadSrc = fs.readFileSync(THREAD, 'utf8');
  const policySrc = fs.readFileSync(POLICY, 'utf8');
  const openSrc = fs.readFileSync(OPEN, 'utf8');
  const naturalSrc = fs.readFileSync(NATURAL, 'utf8');
  const cookedSrc = readStaffPortalUiSource();

  ok('does not read or flip LUNA_AUTO_SEND_ENABLED',
    !/LUNA_AUTO_SEND_ENABLED/.test(threadSrc)
    && !/LUNA_AUTO_SEND_ENABLED/.test(policySrc)
    && !/LUNA_AUTO_SEND_ENABLED/.test(openSrc));

  ok('canned acknowledgment still lives on the policy owner, not a second copy in draft-open',
    /SAFE_ACKNOWLEDGMENT/.test(policySrc)
    && /require\('\.\/email-luna-draft-open-policy-composition'\)/.test(openSrc)
    && !/en: 'Hi,\\n\\nThanks for your message/.test(openSrc));

  ok('skeleton/composer owners exist on inbox-thread.js',
    threadSrc.includes('function buildConvDetailSkeleton(')
    && threadSrc.includes('id="btn-email-approve-send"')
    && threadSrc.includes('id="btn-email-create-draft"'));

  console.log('\n── first-paint chrome (raw HTML, before applyStaffPortalI18n) ──');
  const chromeEs = loadChrome(threadSrc, 'es');
  const chromeEn = loadChrome(threadSrc, 'en');
  ok('buildConvDetailSkeleton is executable', typeof chromeEs.buildConvDetailSkeleton === 'function');

  const skeletonEs = chromeEs.buildConvDetailSkeleton ? chromeEs.buildConvDetailSkeleton() : '';
  const skeletonEn = chromeEn.buildConvDetailSkeleton ? chromeEn.buildConvDetailSkeleton() : '';

  ok('locale=es skeleton first paint is Spanish (Cargando / Respuesta)',
    /Cargando/.test(skeletonEs)
    && /Respuesta:/.test(skeletonEs));
  ok('locale=es skeleton does not paint English Loading/Reply to translate later',
    !/Loading/.test(skeletonEs)
    && !/>Reply:</.test(skeletonEs)
    && !/data-i18n="common\.loading">Loading/.test(skeletonEs)
    && !/data-i18n="inbox\.detail\.reply\.label">Reply:/.test(skeletonEs));
  ok('locale=en skeleton first paint stays English',
    /Loading/.test(skeletonEn)
    && /Reply:/.test(skeletonEn)
    && !/Cargando/.test(skeletonEn)
    && !/Respuesta:/.test(skeletonEn));

  ok('composer chrome helper is the first-paint owner (not a post-render rewrite)',
    typeof chromeEs.inboxEmailComposerChromeHtml === 'function'
    && /inboxEmailComposerChromeHtml\(/.test(threadSrc));

  const composerEs = chromeEs.inboxEmailComposerChromeHtml
    ? chromeEs.inboxEmailComposerChromeHtml({ locked: false }, 'Re: test')
    : '';
  const composerEn = chromeEn.inboxEmailComposerChromeHtml
    ? chromeEn.inboxEmailComposerChromeHtml({ locked: false }, 'Re: test')
    : '';

  ok('locale=es composer first paint is Spanish (Aprobar y enviar / Crear borrador / Contexto / Asunto)',
    !!composerEs
    && /Aprobar y enviar/.test(composerEs)
    && /Crear borrador/.test(composerEs)
    && /Contexto/.test(composerEs)
    && /Asunto/.test(composerEs));
  ok('locale=es composer does not paint English Approve & send / Create Draft / Context / Subject',
    !!composerEs
    && !/Approve &amp; send/.test(composerEs)
    && !/Approve & send/.test(composerEs)
    && !/>Create Draft</.test(composerEs)
    && !/>Context</.test(composerEs)
    && !/>Subject</.test(composerEs));
  ok('locale=en composer first paint stays English',
    /Approve &amp; send/.test(composerEn)
    && /Create Draft/.test(composerEn)
    && /Context/.test(composerEn)
    && /Subject/.test(composerEn)
    && !/Aprobar y enviar/.test(composerEn)
    && !/Crear borrador/.test(composerEn));
  ok('Create Draft still sits next to Approve & send in first-paint chrome',
    composerEn.indexOf('btn-email-create-draft') >= 0
    && composerEn.indexOf('btn-email-approve-send') > composerEn.indexOf('btn-email-create-draft')
    && composerEn.indexOf('inbox-email-create-draft-context') >= 0
    && composerEn.indexOf('inbox-email-create-draft-context') < composerEn.indexOf('btn-email-create-draft'));

  console.log('\n── cooked /staff/ui injection (same owners, not a test rewrite) ──');
  const cookedEs = loadChrome(cookedSrc, 'es');
  const cookedSkeletonEs = cookedEs.buildConvDetailSkeleton ? cookedEs.buildConvDetailSkeleton() : '';
  const cookedComposerEs = cookedEs.inboxEmailComposerChromeHtml
    ? cookedEs.inboxEmailComposerChromeHtml({ locked: false }, 'Re: test')
    : '';
  ok('cooked injected UI skeleton first paint is Spanish',
    /Cargando/.test(cookedSkeletonEs) && /Respuesta:/.test(cookedSkeletonEs) && !/Loading/.test(cookedSkeletonEs));
  ok('cooked injected UI composer first paint is Spanish',
    /Aprobar y enviar/.test(cookedComposerEs)
    && /Crear borrador/.test(cookedComposerEs)
    && !/Approve &amp; send/.test(cookedComposerEs));

  ok('i18n catalog has EN/ES composer keys',
    STAFF_PORTAL_STRINGS.en['inbox.detail.email.approveSend'] === 'Approve & send'
    && STAFF_PORTAL_STRINGS.es['inbox.detail.email.approveSend'] === 'Aprobar y enviar'
    && STAFF_PORTAL_STRINGS.en['inbox.detail.email.createDraft'] === 'Create Draft'
    && STAFF_PORTAL_STRINGS.es['inbox.detail.email.createDraft'] === 'Crear borrador'
    && STAFF_PORTAL_STRINGS.en['common.loading'] === 'Loading…'
    && STAFF_PORTAL_STRINGS.es['common.loading'] === 'Cargando…'
    && STAFF_PORTAL_STRINGS.es['inbox.detail.reply.label'] === 'Respuesta:');

  console.log('\n── canned/safe draft locale (real policy composition) ──');
  ok('inflected Spanish guest mail detects es, not default en',
    detectEmailDraftLanguage(ES_THREAD.subject, ES_THREAD.body_text) === 'es');
  ok('accented Spanish guest mail detects es',
    detectEmailDraftLanguage(ES_ACCENT_THREAD.subject, ES_ACCENT_THREAD.body_text) === 'es');
  ok('English guest mail still detects en',
    detectEmailDraftLanguage(EN_THREAD.subject, EN_THREAD.body_text) === 'en');

  const emptyPlan = JSON.stringify({
    acts: [{ act: 'thank_guest' }, { act: 'offer_human_followup' }],
  });
  const emptyEsBody = renderCreateDraftNaturalPlan({
    acts: [{ act: 'thank_guest' }, { act: 'offer_human_followup' }],
  }, 'es');
  const emptyEnBody = renderCreateDraftNaturalPlan({
    acts: [{ act: 'thank_guest' }, { act: 'offer_human_followup' }],
  }, 'en');

  const unguidedEs = await policyFor(async () => {
    throw new Error('unguided generate-on-open must not call the natural author');
  }).compose({
    authority: authority(),
    untrusted_content: content(ES_THREAD),
    env: env(),
  });
  ok('unguided/generate-on-open Spanish thread keeps locale-correct canned draft',
    unguidedEs.status === 'draft_ready'
    && unguidedEs.language === 'es'
    && unguidedEs.body === SAFE_ACKNOWLEDGMENT.es
    && unguidedEs.body !== SAFE_ACKNOWLEDGMENT.en);

  const emptyEs = await policyFor(async () => emptyPlan).compose({
    authority: authority(),
    untrusted_content: content(ES_THREAD),
    operator_context: '   ',
    env: env(),
  });
  ok('empty-context Spanish Create Draft is locale-correct Sol/natural voice, not canned EN ack',
    emptyEs.status === 'draft_ready'
    && emptyEs.language === 'es'
    && emptyEs.body === emptyEsBody
    && emptyEs.body !== SAFE_ACKNOWLEDGMENT.es
    && emptyEs.body !== SAFE_ACKNOWLEDGMENT.en
    && /^Hola,/.test(emptyEs.body));

  const emptyEn = await policyFor(async () => emptyPlan).compose({
    authority: authority(),
    untrusted_content: content(EN_THREAD),
    operator_context: '',
    env: env(),
  });
  ok('empty-context English Create Draft stays English natural voice, not canned review stub',
    emptyEn.status === 'draft_ready'
    && emptyEn.language === 'en'
    && emptyEn.body === emptyEnBody
    && emptyEn.body !== SAFE_ACKNOWLEDGMENT.en);

  const liveEnBody = renderCreateDraftNaturalPlan({
    acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }],
  }, 'en');
  const liveEsBody = renderCreateDraftNaturalPlan({
    acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }],
  }, 'es');

  const naturalEs = await policyFor(async () => JSON.stringify({
    acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }],
  })).compose({
    authority: authority(),
    untrusted_content: content(ES_THREAD),
    operator_context: LIVE_NOTES,
    env: env(),
  });
  ok('Spanish thread with staff notes is FIX-2 voice, not pasted notes or wrapper',
    naturalEs.status === 'draft_ready'
    && naturalEs.language === 'es'
    && naturalEs.body === liveEsBody
    && /¿Quieres hacer una reserva\?/.test(naturalEs.body)
    && naturalEs.body !== SAFE_ACKNOWLEDGMENT.es);
  try {
    assertNoForbiddenGuestCopy(naturalEs.body, LIVE_NOTES);
    ok('Spanish FIX-2 body does not copy staff notes or restore We also wanted to add', true);
  } catch (err) {
    ok('Spanish FIX-2 body does not copy staff notes or restore We also wanted to add', false, err.message);
  }

  const naturalEn = await policyFor(async () => JSON.stringify({
    acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }],
  })).compose({
    authority: authority(),
    untrusted_content: content(EN_THREAD),
    operator_context: LIVE_NOTES,
    env: env(),
  });
  ok('English thread with staff notes stays English FIX-2 voice',
    naturalEn.status === 'draft_ready'
    && naturalEn.language === 'en'
    && naturalEn.body === liveEnBody
    && /Would you like to make a booking\?/.test(naturalEn.body));
  try {
    assertNoForbiddenGuestCopy(naturalEn.body, LIVE_NOTES);
    ok('English FIX-2 body does not copy staff notes or restore We also wanted to add', true);
  } catch (err) {
    ok('English FIX-2 body does not copy staff notes or restore We also wanted to add', false, err.message);
  }

  ok('policy/natural authors still reject the forbidden wrap phrase',
    !FORBIDDEN_WRAP.test(policySrc)
    && !FORBIDDEN_WRAP.test(openSrc)
    && FORBIDDEN_WRAP.test(naturalSrc) === true
    && /WRAPPER/.test(naturalSrc));

  const hostileEs = await policyFor(async () => emptyPlan).compose({
    authority: authority(),
    untrusted_content: content(ES_THREAD),
    operator_context: 'Diles que hay disponibilidad mañana',
    env: env(),
  });
  ok('filtered hostile Spanish notes stay ES natural voice with no facts or wrap',
    hostileEs.status === 'draft_ready'
    && hostileEs.language === 'es'
    && hostileEs.body === emptyEsBody
    && hostileEs.body !== SAFE_ACKNOWLEDGMENT.es
    && !/disponibilidad|evil\.test|We also wanted to add|loft/i.test(hostileEs.body));

  console.log(`\nverify-bf-016-inbox-es: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
