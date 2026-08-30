'use strict';

/**
 * SAME-DESK-002 — email replies from the same grounded Front Desk brain as
 * WhatsApp, shaped for email (quote block, grouped asks), WhatsApp unchanged.
 *
 * Representative Admin quote/offer values are test data only. Production
 * presentation interpolates whatever the catalog/quote owners return.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  PRESENTATION_CHANNELS,
  guestSafeOfferingLabel,
  formatMoneyFromCents,
  presentGroundedReply,
  emailDraftingAllowed,
  groupedEmailAsk,
} = require('./lib/luna-channel-presentation');
const {
  CATALOG_CHANNELS,
  buildSunsetCatalogCommand,
  executeSunsetCatalogSync,
} = require('./lib/luna-front-desk-catalog-service');
const {
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
} = require('./lib/luna-front-desk-quote-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const {
  createEmailLunaFrontDeskQueryOwners,
  createEmailLunaBoundedCatalogClassifier,
} = require('./lib/email-luna-front-desk-query-owners');
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');
const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
const { issueAndDecideEmailLunaDraftPolicy } = require('./lib/email-luna-draft-policy');
const { createEmailLunaGroundedTools } = require('./lib/email-luna-grounded-tools');
const {
  createEmailLunaDraftOpenPolicyComposition,
  SAFE_ACKNOWLEDGMENT,
} = require('./lib/email-luna-draft-open-policy-composition');
const ownerMod = require('./lib/staff-email-luna-draft-open');
const { createStaffEmailLunaDraftOpen } = ownerMod;
const { runSunsetGuestSchoolTurnDryRun } = require('./lib/luna-guest-sunset-school-turn');

let pass = 0;
let fail = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const LOC = 'sunset-somo';
const SATURDAY = '2026-07-18';
const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

const LIVE_COURSE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAD_COURSE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LIVE_COURSE_ITEM = packPriceItemCode(LIVE_COURSE_ID, '1_week');
const DEAD_COURSE_ITEM = packPriceItemCode(DEAD_COURSE_ID, '1_week');
const LIVE_COURSE_CENTS = 19900;
const DEAD_COURSE_CENTS = 13000;

const LIVE_RENTAL_KEY = 'kayak_rental';
const LIVE_RENTAL_ITEM = `${LIVE_RENTAL_KEY}__1_day`;
const LIVE_RENTAL_LABEL = 'Kayak Pro';
const LIVE_RENTAL_CENTS = 4500;

const DISABLED_RENTAL_KEY = 'board_rental';
const DISABLED_RENTAL_ITEM = `${DISABLED_RENTAL_KEY}__1_day`;
const DISABLED_RENTAL_CENTS = 1500;

const PUBLIC_BUNDLE_KEY = 'board_and_suit_rental';
const PUBLIC_BUNDLE_ITEM = `${PUBLIC_BUNDLE_KEY}__half_day`;
const PUBLIC_BUNDLE_CENTS = 1000;
const PUBLIC_BUNDLE_LABEL = 'Board + Suit';

const IDS = Object.freeze({
  client_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  location_key: 'sunset-somo',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  inbound_message_id: '55555555-5555-4555-8555-555555555555',
});
const STAFF_ID = '66666666-6666-4666-8666-666666666666';
const MAILBOX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRAPH_ID = 'opaque/id+with=padding';
const OTHER_LOCATION = '22222222-2222-4222-8222-222222222223';

function liveExecutors(cfg) {
  return {
    executeCatalog: (command) => executeSunsetCatalogSync(command, { adminCfg: cfg }),
    executeQuote: (command) => executeSunsetQuoteSync(command, { adminCfg: cfg }),
  };
}

function liveQueryOwners(cfg, patch = {}) {
  return createEmailLunaFrontDeskQueryOwners({
    locationKey: LOC,
    expectedClientId: IDS.client_id,
    expectedLocationId: IDS.location_id,
    ...liveExecutors(cfg),
    now: FIXED_NOW,
    defaultServiceDates: [SATURDAY],
    ...patch,
  });
}

function gateOn() {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    STAFF_PORTAL_ORIGIN: 'https://staff.sunset.test',
  };
}

function actor() {
  return Object.freeze(Object.assign(Object.create(null), {
    staff_user_id: STAFF_ID,
    client_id: IDS.client_id,
    role: 'operator',
  }));
}

function openContextRow(patch = {}) {
  return {
    client_id: IDS.client_id,
    client_slug: 'sunset',
    location_id: IDS.location_id,
    location_key: 'sunset-somo',
    endpoint_id: IDS.endpoint_id,
    conversation_id: IDS.conversation_id,
    inbound_message_id: IDS.inbound_message_id,
    channel: 'email',
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_source_message_id: GRAPH_ID,
    endpoint_provider_mailbox_id: MAILBOX,
    event_location_id: IDS.location_id,
    subject: 'Question about prices',
    body_text: '',
    quoted_history: '',
    from_display_name: 'Guest',
    from_address: 'guest@example.test',
    conversation_deleted_at: null,
    conversation_status: 'open',
    needs_human: true,
    latest_message_id: IDS.inbound_message_id,
    staff_reply_draft: null,
    conversation_metadata: {},
    luna_draft_enabled: true,
    luna_on: true,
    global_pause: false,
    ...patch,
  };
}

function makeDraftOpenHarness(options = {}) {
  const row = options.row || openContextRow();
  const store = {
    draft: row.staff_reply_draft != null ? String(row.staff_reply_draft) : '',
    meta: row.conversation_metadata ? { ...row.conversation_metadata } : {},
    needsHuman: row.needs_human,
    queryTexts: [],
    writes: [],
    claims: 0,
  };
  const cfg = options.adminCfg || adminCatalogCfg();
  const owner = createStaffEmailLunaDraftOpen({
    runtimeEnv: gateOn(),
    now: () => Date.now(),
    randomUUID: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    callModel: options.callModel || (() => Promise.resolve(plan('catalog_reply', 'warm', 'ask_dates_and_guest_count', 'thanks'))),
    createLunaRuntime: options.createLunaRuntime || (() => createEmailLunaDraftAuthor({
      callModel: options.callModel || (() => Promise.resolve(plan('catalog_reply', 'warm', 'ask_dates_and_guest_count', 'thanks'))),
    })),
    executeCatalog: options.executeCatalog || liveExecutors(cfg).executeCatalog,
    executeQuote: options.executeQuote || liveExecutors(cfg).executeQuote,
    catalogNow: FIXED_NOW,
    defaultServiceDates: [SATURDAY],
    fetchCurrentMessageContent: async () => Object.freeze({
      latest_text: options.contentText || 'Hi, how much is the kayak?',
    }),
    withPgClient: async (fn) => {
      const pg = {
        async query(sql, params) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          store.queryTexts.push(text);
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_BEGIN || /^BEGIN\b/i.test(text)) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_COMMIT || /^COMMIT\b/i.test(text)) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_ROLLBACK || /^ROLLBACK\b/i.test(text)) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT) {
            const live = { ...row };
            live.staff_reply_draft = store.draft || null;
            live.conversation_metadata = { ...(live.conversation_metadata || {}), ...store.meta };
            live.needs_human = store.needsHuman;
            return { rows: [live] };
          }
          if (text === ownerMod.SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION) {
            if (store.needsHuman !== true) return { rows: [] };
            return {
              rows: [{
                conversation_id: IDS.conversation_id,
                inbound_event_id: IDS.inbound_message_id,
                provider: 'microsoft_graph',
                event_location_id: IDS.location_id,
                location_key: 'sunset-somo',
                provider_mailbox_id: MAILBOX,
                endpoint_provider_mailbox_id: MAILBOX,
              }],
            };
          }
          if (text === ownerMod.SQL_LOCK_EMAIL_LUNA_CREATE_DRAFT) {
            return {
              rows: [{
                conversation_id: IDS.conversation_id,
                inbound_event_id: IDS.inbound_message_id,
                provider: 'microsoft_graph',
                event_location_id: IDS.location_id,
                location_key: 'sunset-somo',
                provider_mailbox_id: MAILBOX,
                endpoint_provider_mailbox_id: MAILBOX,
              }],
            };
          }
          if (text === ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT
              || text === ownerMod.SQL_CLAIM_EMAIL_LUNA_CREATE_DRAFT) {
            store.claims += 1;
            const nextMeta = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
            store.meta = { ...store.meta, ...(nextMeta || {}) };
            return { rows: [{ conversation_id: IDS.conversation_id }] };
          }
          if (text === ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT
              || text === ownerMod.SQL_CAS_EMAIL_LUNA_CREATE_DRAFT) {
            store.draft = params[2];
            const nextMeta = typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3];
            store.meta = { ...store.meta, ...(nextMeta || {}) };
            store.writes.push(params[2]);
            return { rows: [{ staff_reply_draft: params[2] }] };
          }
          if (text === ownerMod.SQL_RELEASE_EMAIL_LUNA_OPEN_CLAIM) {
            return { rows: [{ conversation_id: IDS.conversation_id }] };
          }
          return { rows: [] };
        },
      };
      return fn(pg);
    },
  });
  return { owner, store };
}

function adminCatalogCfg() {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [
      {
        pack_id: LIVE_COURSE_ID,
        label: 'Weekend Intensive',
        active: true,
        age_band: '12_and_up',
        group_size: 8,
        beaches: ['somo'],
        weekly: 'sat_sun',
        schedules: ['0930_1130'],
        price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: LIVE_COURSE_CENTS }],
      },
      {
        pack_id: DEAD_COURSE_ID,
        label: 'Old Kids Camp',
        active: false,
        age_band: '6_to_11',
        group_size: 6,
        beaches: ['somo'],
        weekly: 'sat_sun',
        schedules: ['0930_1130'],
        price_tiers: [{ key: '1_week', label: '1 week', hours: 8, amount_cents: DEAD_COURSE_CENTS }],
      },
    ],
    rental_offerings: [
      {
        offering_key: LIVE_RENTAL_KEY,
        label: LIVE_RENTAL_LABEL,
        active: true,
        client_slug: 'sunset',
        location_id: LOC,
      },
      {
        offering_key: DISABLED_RENTAL_KEY,
        label: 'Old Board',
        active: false,
        client_slug: 'sunset',
        location_id: LOC,
      },
    ],
    prices: [
      {
        id: 'price-live-course',
        category: 'package',
        offering_key: LIVE_COURSE_ITEM,
        item_code: LIVE_COURSE_ITEM,
        amount_cents: LIVE_COURSE_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
      },
      {
        id: 'price-dead-course',
        category: 'package',
        offering_key: DEAD_COURSE_ITEM,
        item_code: DEAD_COURSE_ITEM,
        amount_cents: DEAD_COURSE_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
      },
      {
        id: 'price-kayak',
        category: 'rental',
        offering_key: LIVE_RENTAL_ITEM,
        item_code: LIVE_RENTAL_ITEM,
        amount_cents: LIVE_RENTAL_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
        label: LIVE_RENTAL_LABEL,
        location_id: LOC,
      },
      {
        id: 'price-disabled-board',
        category: 'rental',
        offering_key: DISABLED_RENTAL_ITEM,
        item_code: DISABLED_RENTAL_ITEM,
        amount_cents: DISABLED_RENTAL_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
        label: 'Old Board',
        location_id: LOC,
      },
      {
        id: 'price-public-bundle',
        category: 'rental',
        offering_key: PUBLIC_BUNDLE_ITEM,
        item_code: PUBLIC_BUNDLE_ITEM,
        amount_cents: PUBLIC_BUNDLE_CENTS,
        unit: 'half_day',
        active: true,
        currency: 'EUR',
        label: PUBLIC_BUNDLE_LABEL,
        seed_source: 'public_site',
        pricing_status: 'unverified_seed',
        location_id: LOC,
      },
    ],
  };
}

function envelope(language) {
  return createEmailLunaDraftEnvelope({
    authority: { ...IDS },
    untrusted_content: {
      subject: language === 'es' ? 'Consulta sobre precios' : 'Question about prices',
      body_text: language === 'es' ? 'Hola, ¿cuánto cuesta el kayak?' : 'Hi, how much is the kayak?',
      quoted_history: '',
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    },
  });
}

function issueCatalog(language, factPatch) {
  const env = envelope(language);
  const grounded = {
    fact: 'catalog',
    status: 'found',
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    item: 'kayak_rental',
    label: LIVE_RENTAL_LABEL,
    currency: 'EUR',
    amount_cents: LIVE_RENTAL_CENTS,
    active: true,
    ...factPatch,
  };
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope: env,
    evidence: {
      client_id: IDS.client_id,
      location_id: IDS.location_id,
      conversation_id: IDS.conversation_id,
      endpoint_id: IDS.endpoint_id,
      language,
      identity: 'matched',
      intent: 'catalog_question',
      intent_support: 'supported',
      requested_location_id: IDS.location_id,
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
      required_facts: ['catalog'],
      grounded_results: { catalog: grounded },
    },
  });
  return { envelope: env, evidence: issued.evidence, decision: issued.decision };
}

function plan(templateId, tone, questionKey, ack) {
  return JSON.stringify({
    template_id: templateId,
    tone: tone || 'warm',
    question_key: questionKey || 'none',
    acknowledgment_key: ack || 'thanks',
  });
}

function draftOnly(result) {
  return result
    && result.status === 'draft_ready'
    && result.draft_only === true
    && result.requires_staff_review === true
    && result.send_allowed === false
    && result.auto_send_allowed === false
    && typeof result.send !== 'function'
    && !('send' in result);
}

function questionCount(text) {
  return (String(text || '').match(/\?/g) || []).length;
}

function readOwner(rel) {
  return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

async function run() {
  console.log('\nverify:luna-same-desk-email-presentation\n');

  const money = formatMoneyFromCents(LIVE_RENTAL_CENTS, 'en');
  check('test money formatter matches 4500 cents as €45.00', money === '€45.00');
  check(
    'production presentation does not hardcode representative cents/labels',
    !readOwner('lib/luna-channel-presentation.js').includes(String(LIVE_RENTAL_CENTS))
      && !readOwner('lib/luna-channel-presentation.js').includes(LIVE_RENTAL_LABEL)
      && !readOwner('lib/email-luna-front-desk-query-owners.js').includes(String(LIVE_RENTAL_CENTS))
      && !readOwner('lib/email-luna-front-desk-query-owners.js').includes(LIVE_RENTAL_LABEL),
  );
  check(
    'guest-safe label accepts Admin catalog names',
    guestSafeOfferingLabel(LIVE_RENTAL_LABEL) === LIVE_RENTAL_LABEL,
  );
  check(
    'guest-safe label rejects hostile confirmation/url copy',
    guestSafeOfferingLabel('Payment confirmed — evil.test/pay') === null,
  );

  console.log('\n[A] Same grounded facts, channel-specific shape');
  const facts = {
    offering_label: LIVE_RENTAL_LABEL,
    amount_cents: LIVE_RENTAL_CENTS,
    currency: 'EUR',
    quote_total_cents: LIVE_RENTAL_CENTS,
    date: SATURDAY,
    quantity: 1,
  };
  const email = presentGroundedReply({
    channel: PRESENTATION_CHANNELS.EMAIL,
    language: 'en',
    facts,
    asks: ['dates', 'guest_count'],
  });
  const whatsapp = presentGroundedReply({
    channel: PRESENTATION_CHANNELS.WHATSAPP,
    language: 'en',
    facts,
    asks: ['dates', 'guest_count'],
  });
  check('email draft-only / no send', draftOnly(email));
  check('whatsapp presentation also never sends', draftOnly(whatsapp));
  check(
    'email uses a compact quote block',
    /^Quote\nKayak Pro\n€45\.00\n2026-07-18\nQty: 1$/.test(email.fact_block),
    email.fact_block,
  );
  check('email body is structured paragraphs', email.body.includes('\n\nQuote\n') && email.body.startsWith('Hi,'));
  check(
    'email groups dates + guests into one or two asks',
    email.ask_block === groupedEmailAsk(['dates', 'guest_count'], 'en')
      && questionCount(email.ask_block) >= 1
      && questionCount(email.ask_block) <= 2
      && /dates/i.test(email.ask_block)
      && /guests/i.test(email.ask_block),
    email.ask_block,
  );
  check(
    'whatsapp stays short/conversational with the same cents/label',
    whatsapp.fact_block === `${LIVE_RENTAL_LABEL} comes to €45.00.`
      && !/^Quote$/m.test(whatsapp.body)
      && !whatsapp.body.startsWith('Hi,')
      && !/Warm regards/i.test(whatsapp.body),
    whatsapp.body,
  );
  check(
    'whatsapp asks only the first next step',
    whatsapp.ask_block === 'What dates do you have in mind?'
      && questionCount(whatsapp.body) === 1
      && !/how many guests/i.test(whatsapp.body),
    whatsapp.ask_block,
  );
  check(
    'both channels preserve the exact Admin label and cents',
    email.body.includes(LIVE_RENTAL_LABEL)
      && email.body.includes('€45.00')
      && whatsapp.body.includes(LIVE_RENTAL_LABEL)
      && whatsapp.body.includes('€45.00'),
  );
  check(
    'missing money is not invented',
    presentGroundedReply({
      channel: PRESENTATION_CHANNELS.EMAIL,
      language: 'en',
      facts: { offering_label: LIVE_RENTAL_LABEL },
      asks: [],
    }).fact_block === '',
  );

  console.log('\n[B] Live Admin catalog + Staff API quote through canonical owners');
  const cfg = adminCatalogCfg();
  const catCmd = buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.LUNA_EMAIL,
    trustedLocationId: LOC,
    transportBody: { require_db: true },
    now: FIXED_NOW,
  });
  check('email catalog channel is accepted', catCmd.ok === true, JSON.stringify(catCmd.body));
  const cat = executeSunsetCatalogSync(catCmd.command, { adminCfg: cfg });
  check('email-channel catalog ok', cat.ok === true, JSON.stringify(cat.body));
  const rentals = ((cat.body && cat.body.offerings) || []).filter((o) => o.offering_type === 'rental');
  const kayak = rentals.find((o) => (
    o.offering_id === LIVE_RENTAL_ITEM || o.offering_key === LIVE_RENTAL_KEY
    || String(o.item_code || '') === LIVE_RENTAL_ITEM
  ));
  check('email catalog offers live Kayak Pro', !!(kayak && kayak.label === LIVE_RENTAL_LABEL), JSON.stringify(rentals));
  check(
    'disabled board rental absent from email catalog',
    !rentals.some((o) => o.offering_key === DISABLED_RENTAL_KEY || /old board/i.test(String(o.label || ''))),
    JSON.stringify(rentals),
  );
  check(
    'public-site bundle absent from email catalog',
    !rentals.some((o) => /board\s*\+\s*suit/i.test(String(o.label || ''))),
    JSON.stringify(rentals),
  );

  const quoteCmd = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.LUNA_EMAIL,
    trustedLocationId: LOC,
    transportBody: {
      require_db: true,
      offering_id: LIVE_RENTAL_ITEM,
      service_dates: [SATURDAY],
      quantity: 1,
    },
    now: FIXED_NOW,
  });
  check('email quote channel is accepted', quoteCmd.ok === true, JSON.stringify(quoteCmd.body));
  const quoted = executeSunsetQuoteSync(quoteCmd.command, { adminCfg: cfg });
  const quotedCents = quoted.body && (
    quoted.body.total_cents != null ? quoted.body.total_cents : quoted.body.unit_amount_cents
  );
  check('email-channel quote ok', quoted.ok === true, JSON.stringify(quoted.body));
  check(
    'quoted cents and label match Admin catalog',
    quotedCents === LIVE_RENTAL_CENTS && quoted.body && quoted.body.label === LIVE_RENTAL_LABEL,
    JSON.stringify(quoted.body),
  );

  const waCat = buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: LOC,
    transportBody: { require_db: true },
    now: FIXED_NOW,
  });
  const waQuoted = executeSunsetQuoteSync(
    buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
      trustedLocationId: LOC,
      transportBody: {
        require_db: true,
        offering_id: LIVE_RENTAL_ITEM,
        service_dates: [SATURDAY],
        quantity: 1,
      },
      now: FIXED_NOW,
    }).command,
    { adminCfg: cfg },
  );
  const waCatResult = executeSunsetCatalogSync(waCat.command, { adminCfg: cfg });
  const waKayak = ((waCatResult.body && waCatResult.body.offerings) || []).find((o) => (
    o.offering_id === LIVE_RENTAL_ITEM || String(o.item_code || '') === LIVE_RENTAL_ITEM
  ));
  check(
    'WhatsApp and email catalog resolve the same live offering/price',
    !!(waKayak && kayak && waKayak.label === kayak.label
      && Number(waKayak.unit_amount_cents) === Number(kayak.unit_amount_cents)
      && waQuoted.ok === true
      && (waQuoted.body.total_cents || waQuoted.body.unit_amount_cents) === quotedCents),
  );

  const owners = liveQueryOwners(cfg);
  const tools = createEmailLunaGroundedTools({
    authority: { client_id: IDS.client_id, location_id: IDS.location_id },
    queryOwners: owners,
  });
  const grounded = await tools.query('catalog', { lookup: LIVE_RENTAL_ITEM });
  check(
    'email grounded catalog owner returns Admin Kayak Pro / 4500 cents',
    grounded && grounded.status === 'found'
      && grounded.label === LIVE_RENTAL_LABEL
      && grounded.amount_cents === LIVE_RENTAL_CENTS
      && grounded.item === LIVE_RENTAL_ITEM,
    JSON.stringify(grounded),
  );
  const disabledGrounded = await tools.query('catalog', { lookup: DISABLED_RENTAL_ITEM });
  check(
    'disabled rental is missing_fact, never quoted',
    disabledGrounded && (disabledGrounded.status === 'missing_fact' || disabledGrounded.type === 'missing_fact'),
    JSON.stringify(disabledGrounded),
  );
  const publicGrounded = await tools.query('catalog', { lookup: PUBLIC_BUNDLE_ITEM });
  check(
    'public-site bundle is missing_fact',
    publicGrounded && (publicGrounded.status === 'missing_fact' || publicGrounded.type === 'missing_fact'),
    JSON.stringify(publicGrounded),
  );
  const emptyLookup = await tools.query('catalog', {});
  const blankLookup = await tools.query('catalog', { lookup: '' });
  const unresolved = await tools.query('catalog', { lookup: 'how much is a lesson?' });
  check(
    'empty/unresolved offering lookup is missing_fact, never the first offering',
    emptyLookup && emptyLookup.status === 'missing_fact'
      && blankLookup && blankLookup.status === 'missing_fact'
      && unresolved && unresolved.status === 'missing_fact'
      && !(emptyLookup && emptyLookup.amount_cents)
      && !(unresolved && unresolved.label === LIVE_RENTAL_LABEL),
    JSON.stringify({ emptyLookup, blankLookup, unresolved }),
  );
  const quoteFailOwners = liveQueryOwners(cfg, {
    executeQuote: async () => ({ ok: false, body: { success: false, reason: 'stock_unverified' } }),
  });
  const quoteFailTools = createEmailLunaGroundedTools({
    authority: { client_id: IDS.client_id, location_id: IDS.location_id },
    queryOwners: quoteFailOwners,
  });
  const quoteFailed = await quoteFailTools.query('catalog', { lookup: LIVE_RENTAL_ITEM });
  check(
    'Staff quote/stock failure is missing_fact, not catalog list-price',
    quoteFailed && quoteFailed.status === 'missing_fact'
      && quoteFailed.amount_cents !== LIVE_RENTAL_CENTS,
    JSON.stringify(quoteFailed),
  );
  let factoryThrew = false;
  try {
    createEmailLunaFrontDeskQueryOwners({
      locationKey: LOC,
      expectedClientId: IDS.client_id,
      expectedLocationId: IDS.location_id,
      executeCatalog: liveExecutors(cfg).executeCatalog,
    });
  } catch (err) {
    factoryThrew = err && err.message === 'email_luna_front_desk_query_owners_invalid';
  }
  check('priced query owners require the quote executor', factoryThrew);
  const mismatchTools = createEmailLunaGroundedTools({
    authority: { client_id: IDS.client_id, location_id: OTHER_LOCATION },
    queryOwners: owners,
  });
  const mismatched = await mismatchTools.query('catalog', { lookup: LIVE_RENTAL_ITEM });
  check(
    'authority/location mismatch is handoff, not a stamped foreign catalog',
    mismatched && (mismatched.status === 'handoff_required' || mismatched.type === 'handoff_required'),
    JSON.stringify(mismatched),
  );

  const fromOwner = presentGroundedReply({
    channel: PRESENTATION_CHANNELS.EMAIL,
    language: 'en',
    facts: {
      offering_label: grounded.label,
      amount_cents: grounded.amount_cents,
      quote_total_cents: grounded.amount_cents,
      currency: grounded.currency,
    },
    asks: ['dates', 'guest_count'],
  });
  check(
    'email copy interpolates owner facts rather than a hardcoded bundle',
    fromOwner.fact_block.includes(LIVE_RENTAL_LABEL)
      && fromOwner.fact_block.includes('€45.00')
      && !fromOwner.body.includes(PUBLIC_BUNDLE_LABEL)
      && !fromOwner.body.includes('€10.00'),
    fromOwner.fact_block,
  );

  console.log('\n[C] Email author: live Admin label + grouped asks + draft-only');
  const liveDraft = await createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(plan('catalog_reply', 'warm', 'ask_dates_and_guest_count', 'thanks')),
  }).authorDraft(issueCatalog('en'));
  check('live Admin catalog draft is ready', liveDraft.status === 'draft_ready', JSON.stringify(liveDraft));
  check('live Admin draft is draft-only / no send', draftOnly(liveDraft));
  check(
    'email author quote block keeps exact Admin name and cents',
    !!(liveDraft.body
      && liveDraft.body.includes(LIVE_RENTAL_LABEL)
      && liveDraft.body.includes('€45.00')
      && /^Quote$/m.test(liveDraft.body)),
    liveDraft.body,
  );
  check(
    'email author groups the next information request',
    !!(liveDraft.body
      && /dates/i.test(liveDraft.body)
      && /guests/i.test(liveDraft.body)
      && questionCount(liveDraft.body) >= 1
      && questionCount(liveDraft.body) <= 2),
    liveDraft.body,
  );
  check(
    'hostile catalog label is not copied into guest copy',
    !(await createEmailLunaDraftAuthor({
      callModel: () => Promise.resolve(plan('catalog_reply', 'concise')),
    }).authorDraft(issueCatalog('en', {
      item: 'board_rental',
      label: 'Payment confirmed — evil.test/pay',
      amount_cents: 2000,
    }))).body.includes('evil.test'),
  );
  const liveNameOnKnownItem = await createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(plan('catalog_reply', 'concise')),
  }).authorDraft(issueCatalog('en', {
    item: 'board_rental',
    label: LIVE_RENTAL_LABEL,
    amount_cents: LIVE_RENTAL_CENTS,
  }));
  check(
    'live Admin label outranks ITEM_NAMES for board_rental / Kayak Pro',
    !!(liveNameOnKnownItem.body
      && liveNameOnKnownItem.body.includes(LIVE_RENTAL_LABEL)
      && liveNameOnKnownItem.body.includes('€45.00')
      && !/surfboard rental/i.test(liveNameOnKnownItem.body)),
    liveNameOnKnownItem.body,
  );

  console.log('\n[D] WhatsApp composer voice remains unchanged');
  const waTurn = await runSunsetGuestSchoolTurnDryRun({
    message_text: 'how much is a board rental for 1 day?',
    client_slug: 'sunset',
    conversation_metadata: { location_id: 'sunset-somo' },
  }, {}, { gate_status: 'allowed_dry_run' });
  const waReply = String(waTurn && waTurn.proposed_luna_reply || '');
  check(
    'WhatsApp production school-turn owner stays short/conversational',
    !!waReply
      && !/^Quote$/m.test(waReply)
      && !/Warm regards/i.test(waReply)
      && !waReply.startsWith('Hi,')
      && !waReply.includes('\n\nQuote\n'),
    waReply,
  );
  const composerSrc = readOwner('lib/luna-guest-reply-composer.js');
  check(
    'WhatsApp composer still uses conversational comes-to copy, not an email Quote header',
    composerSrc.includes('The stay comes to ${total} total.')
      && composerSrc.includes('Accommodation comes to ${total}.')
      && /which do you prefer\?/.test(composerSrc)
      && !composerSrc.includes('PRESENTATION_CHANNELS')
      && !composerSrc.includes('compactEmailQuoteBlock')
      && !/^Quote$/m.test(composerSrc),
  );
  check(
    'WhatsApp composer still has one-question intake states, not grouped email asks',
    composerSrc.includes("ask_dates: 'Nice! What dates are you thinking for check-in and check-out?'")
      && composerSrc.includes("ask_guests:")
      && !composerSrc.includes('ask_dates_and_guest_count')
      && !composerSrc.includes('What dates do you have in mind, and how many guests would there be?'),
  );
  const explainerSrc = readOwner('lib/luna-guest-package-explainer.js');
  check(
    'WhatsApp package explainer still owns short chat copy',
    /Malibu/.test(explainerSrc) && !explainerSrc.includes('compactEmailQuoteBlock'),
  );
  const styleSrc = readOwner('lib/luna-guest-reply-style-contract.js');
  check(
    'WhatsApp style contract still requires one clear question and short replies',
    styleSrc.includes('one clear question or next step at a time')
      && styleSrc.includes('MAX_REPLY_CHARS = 900'),
  );

  console.log('\n[E] Drafting gates and no approval/send side effects');
  check(
    'global pause blocks drafting',
    emailDraftingAllowed({ luna_on: true, needs_human: true, global_pause: true }).allowed === false
      && emailDraftingAllowed({ luna_on: true, needs_human: true, global_pause: true }).reason === 'global_pause'
      && emailDraftingAllowed({ luna_on: true, needs_human: true, global_pause: true }).send_allowed === false
      && emailDraftingAllowed({ luna_on: true, needs_human: true, global_pause: true }).auto_send_allowed === false,
  );
  check(
    'Luna Off blocks drafting',
    emailDraftingAllowed({ luna_on: false, needs_human: true, global_pause: false }).allowed === false
      && emailDraftingAllowed({ luna_on: false, needs_human: true, global_pause: false }).reason === 'luna_off',
  );
  check(
    'Needs Human still required for autonomous email drafting',
    emailDraftingAllowed({ luna_on: true, needs_human: false, global_pause: false }).allowed === false
      && emailDraftingAllowed({ luna_on: true, needs_human: false, global_pause: false }).reason === 'needs_human',
  );
  const staffOk = emailDraftingAllowed({
    luna_on: true, needs_human: false, global_pause: false, staff_initiated: true,
  });
  check(
    'staff-initiated draft is allowed when Luna is on / pause off, still no send',
    staffOk.allowed === true && staffOk.send_allowed === false && staffOk.auto_send_allowed === false
      && staffOk.draft_only === true,
  );
  const openOk = emailDraftingAllowed({ luna_on: true, needs_human: true, global_pause: false });
  check(
    'open/autonomous draft allowed only when Luna On + Needs Human + pause off',
    openOk.allowed === true && openOk.send_allowed === false && openOk.auto_send_allowed === false,
  );
  check(
    'missing/malformed drafting state fails closed',
    emailDraftingAllowed({}).allowed === false
      && emailDraftingAllowed(null).allowed === false
      && emailDraftingAllowed({ luna_on: true, needs_human: true }).allowed === false
      && emailDraftingAllowed({ global_pause: false, needs_human: true }).allowed === false,
  );

  const openSrc = readOwner('lib/staff-email-luna-draft-open.js');
  check(
    'open-draft claim still requires needs_human',
    /needs_human IS TRUE/.test(openSrc) && /AND c\.needs_human IS TRUE/.test(openSrc),
  );
  check(
    'production draft-open binds Front Desk owners, classifier, and emailDraftingAllowed',
    openSrc.includes('createEmailLunaFrontDeskQueryOwners')
      && openSrc.includes('createEmailLunaBoundedCatalogClassifier')
      && openSrc.includes('emailDraftingAllowed')
      && openSrc.includes('executeSunsetCatalog')
      && openSrc.includes('executeSunsetQuote')
      && openSrc.includes('bot_pause_states')
      && openSrc.includes('inbox_channel_modes'),
  );
  check(
    'open-draft owner has no approve/send/provider dispatch',
    !/handleApproveSend|dispatchApprovedOutbound|createReply|sendDraft/.test(openSrc),
  );
  const authorSrc = readOwner('lib/email-luna-draft-author.js');
  check(
    'email author never enables auto-send or send_allowed',
    /\['auto_send_allowed',false\]/.test(authorSrc)
      && /\['send_allowed',false\]/.test(authorSrc)
      && /\['draft_only',true\]/.test(authorSrc)
      && !/auto_send_allowed',\s*true/.test(authorSrc),
  );
  const presentationSrc = readOwner('lib/luna-channel-presentation.js');
  check(
    'presentation seam has no send/approve/payment-link side effects',
    !/handleApproveSend|createReply|sendMail|createPaymentLink|stripe/i.test(presentationSrc)
      && presentationSrc.includes('send_allowed: false')
      && presentationSrc.includes('auto_send_allowed: false'),
  );

  console.log('\n[F] Outer policy composition uses live Admin identity + Staff quote');
  const composed = await createEmailLunaDraftOpenPolicyComposition({
    classifyIntent: createEmailLunaBoundedCatalogClassifier(),
    queryOwners: liveQueryOwners(cfg),
    createLunaRuntime: () => createEmailLunaDraftAuthor({
      callModel: () => Promise.resolve(plan('catalog_reply', 'warm', 'ask_dates_and_guest_count', 'thanks')),
    }),
  }).compose({
    authority: { ...IDS },
    untrusted_content: {
      subject: 'Question about prices',
      body_text: 'Hi, how much is the kayak?',
      quoted_history: '',
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    },
  });
  check('policy composition is draft-ready / draft-only', draftOnly(composed) && composed.status === 'draft_ready');
  check(
    'policy composition quotes live Admin Kayak Pro, not a generic safe ack',
    !!(composed.body
      && composed.body.includes(LIVE_RENTAL_LABEL)
      && composed.body.includes('€45.00')
      && composed.body !== SAFE_ACKNOWLEDGMENT.en
      && !/surfboard rental/i.test(composed.body)
      && composed.send_allowed === false
      && composed.auto_send_allowed === false),
    composed.body,
  );
  const unresolvedCompose = await createEmailLunaDraftOpenPolicyComposition({
    classifyIntent: createEmailLunaBoundedCatalogClassifier(),
    queryOwners: liveQueryOwners(cfg),
    createLunaRuntime: () => createEmailLunaDraftAuthor({
      callModel: () => Promise.resolve(plan('catalog_reply', 'concise')),
    }),
  }).compose({
    authority: { ...IDS },
    untrusted_content: {
      subject: 'Hello',
      body_text: 'Hi, how much is a lesson?',
      quoted_history: '',
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    },
  });
  check(
    'unresolved offering identity stays a safe handoff, not the first catalog row',
    unresolvedCompose.body === SAFE_ACKNOWLEDGMENT.en
      || unresolvedCompose.status === 'handoff_required'
      || unresolvedCompose.kind === 'safe_acknowledgment',
    JSON.stringify({ kind: unresolvedCompose.kind, reason: unresolvedCompose.reason, body: unresolvedCompose.body }),
  );

  console.log('\n[G] Production draft-open owner, no helper-injected facts');
  const liveOpen = makeDraftOpenHarness({ adminCfg: cfg });
  const opened = await liveOpen.owner.ensureEmailLunaDraftOnOpen({
    actor: actor(),
    conversation_id: IDS.conversation_id,
  });
  check(
    'createStaffEmailLunaDraftOpen persists live Admin Kayak Pro / Staff quote',
    opened.status === 'draft_ready'
      && typeof opened.draft_text === 'string'
      && opened.draft_text.includes(LIVE_RENTAL_LABEL)
      && opened.draft_text.includes('€45.00')
      && opened.draft_text !== SAFE_ACKNOWLEDGMENT.en
      && opened.send_allowed === false
      && opened.auto_send_allowed === false
      && liveOpen.store.writes.length === 1,
    JSON.stringify({ status: opened.status, body: opened.draft_text, writes: liveOpen.store.writes.length }),
  );
  check(
    'draft-open does not call injected queryOwners — production bind used live executors',
    !readOwner('lib/staff-email-luna-draft-open.js').includes('issueCatalog(')
      && liveOpen.store.claims >= 1,
  );

  console.log('\n[H] Real drafting gates on the open/create-draft owner');
  const paused = makeDraftOpenHarness({ row: openContextRow({ global_pause: true }), adminCfg: cfg });
  const pausedOut = await paused.owner.ensureEmailLunaDraftOnOpen({
    actor: actor(),
    conversation_id: IDS.conversation_id,
  });
  check(
    'Global Pause blocks generate-on-open before a new Luna body is written',
    pausedOut.status === 'pending' && paused.store.writes.length === 0 && paused.store.claims === 0,
    JSON.stringify(pausedOut),
  );
  const lunaOff = makeDraftOpenHarness({ row: openContextRow({ luna_on: false }), adminCfg: cfg });
  const lunaOffOut = await lunaOff.owner.ensureEmailLunaDraftOnOpen({
    actor: actor(),
    conversation_id: IDS.conversation_id,
  });
  check(
    'Luna Off blocks generate-on-open',
    lunaOffOut.status === 'pending' && lunaOff.store.writes.length === 0 && lunaOff.store.claims === 0,
    JSON.stringify(lunaOffOut),
  );
  const noHuman = makeDraftOpenHarness({ row: openContextRow({ needs_human: false }), adminCfg: cfg });
  noHuman.store.needsHuman = false;
  const noHumanOut = await noHuman.owner.ensureEmailLunaDraftOnOpen({
    actor: actor(),
    conversation_id: IDS.conversation_id,
  });
  check(
    'autonomous open still requires Needs Human',
    noHumanOut.status === 'pending' && noHuman.store.writes.length === 0,
    JSON.stringify(noHumanOut),
  );
  const malformed = makeDraftOpenHarness({
    row: openContextRow({ luna_on: undefined, global_pause: undefined }),
    adminCfg: cfg,
  });
  const malformedOut = await malformed.owner.ensureEmailLunaDraftOnOpen({
    actor: actor(),
    conversation_id: IDS.conversation_id,
  });
  check(
    'missing luna_on/global_pause on the loaded row fails closed',
    malformedOut.status === 'pending' && malformed.store.claims === 0,
    JSON.stringify(malformedOut),
  );
  const staffPaused = makeDraftOpenHarness({
    row: openContextRow({ needs_human: false, global_pause: true }),
    adminCfg: cfg,
  });
  staffPaused.store.needsHuman = false;
  const staffPausedOut = await staffPaused.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: IDS.conversation_id,
    operator_context: 'Thank them',
  });
  check(
    'Staff Create Draft still requires pause off',
    staffPausedOut.status === 'pending' && staffPaused.store.claims === 0,
    JSON.stringify(staffPausedOut),
  );
  const staffOff = makeDraftOpenHarness({
    row: openContextRow({ needs_human: false, luna_on: false }),
    adminCfg: cfg,
  });
  staffOff.store.needsHuman = false;
  const staffOffOut = await staffOff.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: IDS.conversation_id,
    operator_context: 'Thank them',
  });
  check(
    'Staff Create Draft still requires Luna On',
    staffOffOut.status === 'pending' && staffOff.store.claims === 0,
    JSON.stringify(staffOffOut),
  );
  const staffOkOpen = makeDraftOpenHarness({
    row: openContextRow({ needs_human: false }),
    adminCfg: cfg,
  });
  staffOkOpen.store.needsHuman = false;
  const staffOkOut = await staffOkOpen.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: IDS.conversation_id,
    operator_context: 'Thank them',
  });
  check(
    'Staff Create Draft may bypass Needs Human when Luna is on and pause is off',
    staffOkOpen.store.claims >= 1,
    JSON.stringify({ status: staffOkOut.status, claims: staffOkOpen.store.claims }),
  );

  const apiSrc = readOwner('staff-query-api.js');
  check(
    'Staff API production still does not forge a classifier/queryOwners literal',
    !/classifyIntent:\s*\(/.test(apiSrc) && !/queryOwners:\s*\{/.test(apiSrc),
  );

  console.log(`\n── verify:luna-same-desk-email-presentation ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
