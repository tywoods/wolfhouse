#!/usr/bin/env node
'use strict';

/**
 * verify:luna-personality-contract
 *
 * Slice 1 of LUNA-PERSONALITY-001 — closed IDs, product name, and the
 * reviewed English/Spanish acceptance corpus.
 *
 * Offline. No network, no DB, no outbound send.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKS_PATH = path.join(ROOT, 'scripts/lib/luna-guest-personality-packs.js');
const CORPUS_PATH = path.join(ROOT, 'fixtures/luna-personality-corpus.json');
const SPEC_PATH = path.join(ROOT, 'docs/LUNA-GUEST-BEHAVIOR-SPEC.md');

const CLOSED_IDS = ['sunny', 'calm', 'concise', 'extra'];
const LATAM_MARKERS = /\b(celular|ustedes|vos sos|\bche\b|okis|okey|computadora)\b/i;
const PENINSULAR_MARKERS = /\b(vale|móvil|vosotros|tenéis|queréis|vais|ordenador|vuestro)\b/i;

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

function emojiCount(text) {
  const matches = String(text || '').match(/\p{Extended_Pictographic}/gu);
  return matches ? matches.length : 0;
}

function bangCount(text) {
  return (String(text || '').match(/!/g) || []).length;
}

console.log('\nverify:luna-personality-contract — Luna Personality closed IDs + corpus\n');

console.log('[1] Owner module');
ok('packs module exists', fs.existsSync(PACKS_PATH), PACKS_PATH);

let packs;
try {
  packs = require('./lib/luna-guest-personality-packs');
  ok('packs module loads', true);
} catch (err) {
  ok('packs module loads', false, err && err.message);
  console.log(`\nverify:luna-personality-contract: ${pass} passed, ${fail} failed`);
  process.exit(1);
}

ok('product name is Luna Personality', packs.PRODUCT_NAME === 'Luna Personality');
ok('supersedes Luna Voices', packs.SUPERSEDES === 'Luna Voices');
ok('channel is whatsapp-only', packs.CHANNEL === 'whatsapp');
ok('settings JSONB key is luna_personality', packs.SETTINGS_KEY === 'luna_personality');
ok('default id is sunny', packs.DEFAULT_PERSONALITY_ID === 'sunny');
ok('closed ids are sunny/calm/concise/extra',
  Array.isArray(packs.CLOSED_PERSONALITY_IDS)
  && packs.CLOSED_PERSONALITY_IDS.length === 4
  && CLOSED_IDS.every((id) => packs.CLOSED_PERSONALITY_IDS.includes(id)));

ok('isClosedPersonalityId exported', typeof packs.isClosedPersonalityId === 'function');
ok('sunny is closed', packs.isClosedPersonalityId('sunny') === true);
ok('unknown id rejected', packs.isClosedPersonalityId('cami') === false
  && packs.isClosedPersonalityId('luna_safe') === false
  && packs.isClosedPersonalityId('extra-bright') === false
  && packs.isClosedPersonalityId('') === false
  && packs.isClosedPersonalityId(null) === false);

ok('normalizeStoredPersonalityId exported', typeof packs.normalizeStoredPersonalityId === 'function');
ok('missing stored id → sunny + default', (() => {
  const r = packs.normalizeStoredPersonalityId(null);
  return r.id === 'sunny' && r.source === 'default';
})());
ok('unknown stored id → sunny + invalid_fallback', (() => {
  const r = packs.normalizeStoredPersonalityId('cami');
  return r.id === 'sunny' && r.source === 'invalid_fallback';
})());
ok('valid stored id stays closed', packs.normalizeStoredPersonalityId('calm').id === 'calm'
  && packs.normalizeStoredPersonalityId('calm').source === 'stored');

ok('getPersonalityPack exported', typeof packs.getPersonalityPack === 'function');
ok('reject caller style prompt text', typeof packs.assertNoCallerStyleText === 'function');

const packById = {};
for (const id of CLOSED_IDS) {
  const pack = packs.getPersonalityPack(id);
  packById[id] = pack;
  ok(`${id} pack is frozen/immutable`, pack && pack.id === id && Object.isFrozen(pack));
  ok(`${id} pack has short instruction (not a free-form prompt editor)`,
    pack && typeof pack.instruction === 'string'
    && pack.instruction.length > 40
    && pack.instruction.length < 900);
  ok(`${id} pack forbids fact/tool/identity changes`,
    /never (change|alter) (facts|prices|availability|tool)/i.test(pack.instruction)
    || /wording|cadence|warmth|emoji/i.test(pack.instruction));
  ok(`${id} pack does not accept caller prompt`,
    !/use the caller's prompt|guest-supplied style/i.test(pack.instruction));
}

ok('sunny maps to current live tone',
  /upbeat|playful|surf-host|warm/i.test(packById.sunny.instruction)
  && /light emoji|0–2|0-2|tasteful emoji/i.test(packById.sunny.instruction));
ok('calm is patient/low-key', /patient|reassuring|low-key/i.test(packById.calm.instruction));
ok('concise is friendly but short', /short|brief|concise/i.test(packById.concise.instruction));
ok('extra is ultra bright', /ultra|over-the-top|extra bright|very bright/i.test(packById.extra.instruction));

ok('getPersonalityPack(unknown) safely resolves to sunny',
  packs.getPersonalityPack('nope').id === 'sunny');
ok('assertNoCallerStyleText rejects prompt fields', (() => {
  try {
    packs.assertNoCallerStyleText({ personality_id: 'sunny', prompt: 'be sassy' });
    return false;
  } catch (err) {
    return /style|prompt|rejected/i.test(String(err && err.message));
  }
})());
ok('assertNoCallerStyleText allows closed id only', (() => {
  try {
    packs.assertNoCallerStyleText({ personality_id: 'calm' });
    return true;
  } catch (_) {
    return false;
  }
})());

ok('observability shape is tenant/channel/id/source/fallback only',
  typeof packs.personalityObservability === 'function'
  && (() => {
    const obs = packs.personalityObservability({
      tenant_id: 't1',
      channel: 'whatsapp',
      personality_id: 'calm',
      source: 'stored',
      fallback_reason: null,
    });
    const keys = Object.keys(obs).sort();
    return keys.join(',') === 'channel,fallback_reason,personality_id,source,tenant_id'
      && !JSON.stringify(obs).includes('Hey')
      && obs.personality_id === 'calm';
  })());

console.log('\n[2] Reviewed EN/ES corpus');
ok('corpus file exists', fs.existsSync(CORPUS_PATH), CORPUS_PATH);

let corpus;
try {
  corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  ok('corpus JSON parses', true);
} catch (err) {
  ok('corpus JSON parses', false, err && err.message);
  console.log(`\nverify:luna-personality-contract: ${pass} passed, ${fail} failed`);
  process.exit(1);
}

ok('corpus names Luna Personality', corpus.product === 'Luna Personality');
ok('corpus owner is packs module', corpus.owner === 'scripts/lib/luna-guest-personality-packs.js');
ok('corpus gate is this verifier', corpus.gate === 'scripts/verify-luna-personality-contract.js');
ok('corpus spanish variant is peninsular', corpus.spanish_variant === 'peninsular');
ok('corpus closed ids match', Array.isArray(corpus.closed_ids)
  && CLOSED_IDS.every((id) => corpus.closed_ids.includes(id)));

const cases = Array.isArray(corpus.cases) ? corpus.cases : [];
ok('corpus has warmth + frozen cases', cases.length >= 8, `${cases.length} cases`);

const warmthEn = cases.filter((c) => c.kind === 'warmth_eligible' && c.lang === 'en');
const warmthEs = cases.filter((c) => c.kind === 'warmth_eligible' && c.lang === 'es');
const frozen = cases.filter((c) => c.kind === 'truth_frozen' || c.kind === 'invariant');
ok('EN warmth cases cover all 4 packs', warmthEn.length >= 2
  && warmthEn.every((c) => CLOSED_IDS.every((id) => c.replies && typeof c.replies[id] === 'string' && c.replies[id].trim())));
ok('ES warmth cases cover all 4 packs', warmthEs.length >= 2
  && warmthEs.every((c) => CLOSED_IDS.every((id) => c.replies && typeof c.replies[id] === 'string' && c.replies[id].trim())));
ok('truth-frozen / invariant cases exist', frozen.length >= 2);

for (const c of cases) {
  ok(`${c.id} has meaning + composer_state`, !!(c && c.id && c.meaning && c.composer_state && c.lang));
  if (!c.replies) continue;
  for (const id of CLOSED_IDS) {
    const reply = c.replies[id];
    if (typeof reply !== 'string') continue;
    ok(`${c.id}/${id} has no internal jargon`,
      !/\b(composer|staging|dry run|orchestrator|tool|prompt)\b/i.test(reply));
    if (Array.isArray(c.frozen_facts)) {
      for (const fact of c.frozen_facts) {
        ok(`${c.id}/${id} preserves frozen fact "${fact}"`, reply.includes(fact));
      }
    }
  }
}

for (const c of warmthEn.concat(warmthEs)) {
  const replies = CLOSED_IDS.map((id) => c.replies[id]);
  const unique = new Set(replies);
  ok(`${c.id} stylistic difference across packs (not identical copy)`, unique.size === 4);
  ok(`${c.id} extra is brighter than calm (emoji or bangs)`,
    emojiCount(c.replies.extra) + bangCount(c.replies.extra)
    > emojiCount(c.replies.calm) + bangCount(c.replies.calm));
  ok(`${c.id} concise is shorter than extra`,
    c.replies.concise.length < c.replies.extra.length);
  ok(`${c.id} meaning-preserving (shared meaning tokens)`, (() => {
    const tokens = String(c.meaning_tokens || c.meaning || '')
      .toLowerCase()
      .split(/[^a-záéíóúüñ]+/i)
      .filter((w) => w.length >= 4);
    if (!tokens.length) return false;
    const must = tokens.slice(0, 2);
    return CLOSED_IDS.every((id) => {
      const lower = c.replies[id].toLowerCase();
      return must.some((t) => lower.includes(t)) || (c.shared_tokens || []).every((t) => lower.includes(String(t).toLowerCase()));
    });
  })());
}

for (const c of frozen) {
  const replies = CLOSED_IDS.map((id) => c.replies[id]);
  ok(`${c.id} style-frozen (identical truth copy across packs)`,
    replies.every((r) => r === replies[0]));
}

for (const c of warmthEs) {
  for (const id of CLOSED_IDS) {
    const reply = c.replies[id];
    ok(`${c.id}/${id} Spanish is peninsular (no LATAM markers)`, !LATAM_MARKERS.test(reply));
  }
  ok(`${c.id} uses at least one peninsular cue across packs`,
    CLOSED_IDS.some((id) => PENINSULAR_MARKERS.test(c.replies[id])));
}

console.log('\n[3] Spec owner row');
const spec = fs.readFileSync(SPEC_PATH, 'utf8');
ok('behavior spec names Luna Personality', /Luna Personality/.test(spec));
ok('spec owner is packs module', /luna-guest-personality-packs\.js/.test(spec));
ok('spec says wording only / never facts', /wording|cadence|warmth|emoji/i.test(spec)
  && /never alters? facts|never changes verified facts/i.test(spec));

console.log(`\nverify:luna-personality-contract: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
