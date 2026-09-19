'use strict';

/**
 * EMAIL-OPEN-DRAFT-BOOKING-001
 *
 * Multi-item email open-draft: guest-named distinct offerings compose one
 * grounded catalog fact. Ambiguous generics stay unresolved. Authored body
 * is not SAFE_ACKNOWLEDGMENT and never says Automatización.
 *
 * Run: node scripts/verify-email-open-draft-booking-001.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  selectCatalogOfferings,
  uniqueMatchingOffering,
  combineCatalogFacts,
  createEmailLunaBoundedCatalogClassifier,
  createEmailLunaFrontDeskQueryOwners,
} = require('./lib/email-luna-front-desk-query-owners');
const {
  createEmailLunaDraftOpenPolicyComposition,
  SAFE_ACKNOWLEDGMENT,
} = require('./lib/email-luna-draft-open-policy-composition');
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');

const ROOT = path.join(__dirname, '..');
const OWNER_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'email-luna-front-desk-query-owners.js'),
  'utf8',
);

const AUTH = Object.freeze({
  client_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  location_key: 'sunset-somo',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  inbound_message_id: '55555555-5555-4555-8555-555555555555',
});

const OFFERINGS = [
  {
    offering_id: 'kayak_rental__1_day',
    offering_key: 'kayak_rental',
    label: 'Kayak Pro',
    unit_amount_cents: 4500,
    currency: 'EUR',
    active: true,
  },
  {
    offering_id: 'board_rental__1_day',
    offering_key: 'board_rental',
    label: 'Surfboard',
    unit_amount_cents: 2500,
    currency: 'EUR',
    active: true,
  },
  {
    offering_id: 'wetsuit_rental__1_day',
    offering_key: 'wetsuit_rental',
    label: 'Wetsuit',
    unit_amount_cents: 1500,
    currency: 'EUR',
    active: true,
  },
  {
    offering_id: 'group_a__1_week',
    offering_key: 'group_lesson',
    label: 'Beginner week',
    unit_amount_cents: 19900,
    currency: 'EUR',
    active: true,
  },
  {
    offering_id: 'group_b__1_week',
    offering_key: 'group_lesson',
    label: 'Intermediate week',
    unit_amount_cents: 21900,
    currency: 'EUR',
    active: true,
  },
];

function fact(offering) {
  return {
    fact: 'catalog',
    status: 'found',
    client_id: AUTH.client_id,
    location_id: AUTH.location_id,
    item: offering.offering_id,
    label: offering.label,
    currency: 'EUR',
    amount_cents: offering.unit_amount_cents,
    active: true,
  };
}

async function main() {
  console.log('verify:email-open-draft-booking-001\n');

  assert.match(OWNER_SRC, /function selectCatalogOfferings/);
  assert.match(OWNER_SRC, /selectCatalogOfferings\(offerings, lookup, authority\)/);
  assert.doesNotMatch(OWNER_SRC, /Automatizaci[oó]n/);
  console.log('  PASS  owner selects multi-item offerings; no Automatización');

  const kayakOnly = uniqueMatchingOffering(OFFERINGS, 'how much is the kayak?', AUTH);
  assert.equal(kayakOnly && kayakOnly.offering_id, 'kayak_rental__1_day');
  console.log('  PASS  unique kayak still matches one row');

  const lesson = selectCatalogOfferings(OFFERINGS, 'Hi, how much is a lesson?', AUTH);
  assert.deepEqual(lesson, []);
  console.log('  PASS  generic lesson stays unresolved (not first row)');

  const multi = selectCatalogOfferings(
    OFFERINGS,
    'Hi, how much is the kayak and the board?',
    AUTH,
  );
  assert.equal(multi.length, 2);
  const ids = multi.map((row) => row.offering_id).sort();
  assert.deepEqual(ids, ['board_rental__1_day', 'kayak_rental__1_day']);
  console.log('  PASS  kayak + board are distinct requested offerings');

  const combined = combineCatalogFacts([
    fact(OFFERINGS[0]),
    fact(OFFERINGS[1]),
  ]);
  assert.equal(combined.status, 'found');
  assert.equal(combined.amount_cents, 7000);
  assert.match(combined.label, /Kayak Pro/);
  assert.match(combined.label, /Surfboard/);
  assert.ok(combined.label.length <= 80);
  console.log('  PASS  combined catalog fact sums both items');

  const owners = createEmailLunaFrontDeskQueryOwners({
    locationKey: AUTH.location_key,
    expectedClientId: AUTH.client_id,
    expectedLocationId: AUTH.location_id,
    executeCatalog: async () => ({ ok: true, body: { offerings: OFFERINGS } }),
    executeQuote: async (command) => {
      const id = command && command.transportBody && command.transportBody.offering_id;
      const row = OFFERINGS.find((o) => o.offering_id === id);
      if (!row) return { ok: false };
      return {
        ok: true,
        body: {
          success: true,
          label: row.label,
          offering_id: row.offering_id,
          total_cents: row.unit_amount_cents,
          currency: 'EUR',
        },
      };
    },
    now: new Date('2026-07-14T12:00:00Z'),
    defaultServiceDates: ['2026-07-18'],
  });

  const catalogFact = await owners.catalog(AUTH, {
    lookup: 'Hi, how much is the kayak and the board?',
  });
  assert.equal(catalogFact.fact, 'catalog');
  assert.equal(catalogFact.amount_cents, 7000);
  assert.match(catalogFact.label, /Kayak Pro/);
  assert.match(catalogFact.label, /Surfboard/);
  console.log('  PASS  catalog owner quotes both named items');

  const unresolved = await owners.catalog(AUTH, { lookup: 'Hi, how much is a lesson?' });
  assert.deepEqual(unresolved, []);
  console.log('  PASS  unresolved lesson catalog is empty');

  const composed = await createEmailLunaDraftOpenPolicyComposition({
    classifyIntent: createEmailLunaBoundedCatalogClassifier(),
    queryOwners: owners,
    createLunaRuntime: () => createEmailLunaDraftAuthor({
      callModel: () => Promise.resolve(JSON.stringify({
        template_id: 'catalog_reply',
        tone: 'warm',
        question_key: 'ask_dates',
        acknowledgment_key: 'thanks',
      })),
    }),
  }).compose({
    authority: AUTH,
    untrusted_content: {
      subject: 'Question about prices',
      body_text: 'Hi, how much is the kayak and the board?',
      quoted_history: '',
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    },
  });

  assert.equal(composed.status, 'draft_ready');
  assert.equal(composed.kind, 'authored');
  assert.notEqual(composed.body, SAFE_ACKNOWLEDGMENT.en);
  assert.notEqual(composed.body, SAFE_ACKNOWLEDGMENT.es);
  assert.equal(composed.send_allowed, false);
  assert.doesNotMatch(composed.body, /Automatizaci[oó]n/i);
  assert.doesNotMatch(composed.body, /\bAutomation\b/);
  assert.match(composed.body, /Kayak Pro/);
  assert.match(composed.body, /Surfboard/);
  assert.match(composed.body, /€70\.00/);
  console.log('  PASS  multi-item open-draft is authored, not SAFE_ACKNOWLEDGMENT');
  console.log('  PASS  authored body has no Automatización');

  const lessonCompose = await createEmailLunaDraftOpenPolicyComposition({
    classifyIntent: createEmailLunaBoundedCatalogClassifier(),
    queryOwners: owners,
    createLunaRuntime: () => createEmailLunaDraftAuthor({
      callModel: () => Promise.resolve(JSON.stringify({
        template_id: 'catalog_reply',
        tone: 'concise',
        question_key: 'none',
        acknowledgment_key: 'noted',
      })),
    }),
  }).compose({
    authority: AUTH,
    untrusted_content: {
      subject: 'Hello',
      body_text: 'Hi, how much is a lesson?',
      quoted_history: '',
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    },
  });
  assert.ok(
    lessonCompose.body === SAFE_ACKNOWLEDGMENT.en
      || lessonCompose.kind === 'safe_acknowledgment'
      || lessonCompose.status === 'handoff_required',
  );
  console.log('  PASS  unresolved lesson still safe-acks (not first catalog row)');

  console.log('\nverify:email-open-draft-booking-001 — ALL CHECKS PASSED\n');
}

main().catch((err) => {
  console.error('FAIL EMAIL-OPEN-DRAFT-BOOKING-001', err && err.stack ? err.stack : err);
  process.exit(1);
});
