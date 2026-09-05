#!/usr/bin/env node
'use strict';

/**
 * verify:luna-personality-no-send
 *
 * Slice 4 — Sunset-staging-capable no-send acceptance. Runs offline against
 * the reviewed corpus + fake Staff settings. Never sends WhatsApp.
 *
 *   node scripts/verify-luna-personality-no-send.js
 *   npm run verify:luna-personality-no-send
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts/lib/luna-guest-personality-no-send.js');
const CORPUS_PATH = path.join(ROOT, 'fixtures/luna-personality-corpus.json');
const SEND_FLAGS = path.join(ROOT, 'scripts/lib/luna-send-flags.js');
const SEND_FLAGS_ALT = path.join(ROOT, 'docker/hermes-staging/wolfhouse/send_flags.py');

const CLOSED_IDS = ['sunny', 'calm', 'concise', 'extra'];

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

console.log('\nverify:luna-personality-no-send — offline WhatsApp personality acceptance\n');

ok('no-send module exists', fs.existsSync(MODULE_PATH), MODULE_PATH);

let sim;
try {
  sim = require('./lib/luna-guest-personality-no-send');
  ok('no-send module loads', true);
} catch (err) {
  ok('no-send module loads', false, err && err.message);
  console.log(`\nverify:luna-personality-no-send: ${pass} passed, ${fail} failed`);
  process.exit(1);
}

ok('runNoSendAcceptance exported', typeof sim.runNoSendAcceptance === 'function');
ok('createNoSendHarness exported', typeof sim.createNoSendHarness === 'function');
ok('never enables auto-send', sim.AUTO_SEND_ENABLED === false);
ok('whatsapp send suppressed', sim.WHATSAPP_SUPPRESSED === true);

const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));

(async () => {
  const report = await sim.runNoSendAcceptance({ corpus });
  ok('acceptance ran', report && report.ok === true, report && report.error);
  ok('covers all four closed IDs', Array.isArray(report.ids) && CLOSED_IDS.every((id) => report.ids.includes(id)));
  ok('covers EN and ES', report.langs && report.langs.includes('en') && report.langs.includes('es'));
  ok('no outbound sends', report.sends === 0 && report.whatsapp_suppressed === true);
  ok('sunset tenant exercised', report.tenants && report.tenants.includes('sunset'));

  ok('default missing setting → sunny', report.default_id === 'sunny');
  ok('invalid stored id → sunny', report.invalid_resolved === 'sunny');
  ok('fetch failure → sunny and reply still produced',
    report.failure_resolved === 'sunny' && report.failure_blocked !== true);

  ok('tenant isolation', report.tenant_isolation === true);
  ok('sibling settings preserved', report.siblings_preserved === true);
  ok('one resolution per turn', report.max_resolves_per_turn === 1);
  ok('one injection per warmth turn', report.max_injections_per_warmth_turn === 1);
  ok('truth/tool/identity frozen across packs', report.invariants_ok === true);
  ok('warmth turns stylistically distinct', report.warmth_distinct === true);
  ok('spanish remains peninsular', report.spanish_peninsular === true);

  const harness = sim.createNoSendHarness({
    tenants: {
      sunset: { settings: { inbox_channel_modes: { whatsapp: 'auto' }, house_notes: 'keep' } },
      'wolfhouse-somo': { settings: { luna_personality: 'calm', inbox_channel_modes: { whatsapp: 'draft' } } },
    },
  });
  const turn = await harness.runTurn({
    tenant_id: 'sunset',
    case_id: 'warmth-greeting-en',
    personality_id: 'extra',
  });
  ok('setting change applies to the next reply',
    turn.personality_id === 'extra' && /Yesss|amazing|🙌/.test(turn.reply));
  const next = await harness.runTurn({
    tenant_id: 'sunset',
    case_id: 'warmth-greeting-en',
    personality_id: 'concise',
  });
  ok('next turn picks up concise', next.personality_id === 'concise' && next.reply.length < turn.reply.length);

  const frozen = await harness.runTurn({
    tenant_id: 'sunset',
    case_id: 'truth-payment-link-en',
    personality_id: 'extra',
  });
  ok('composer truth is not restyled',
    frozen.injected === false
    && frozen.reply.includes('https://pay.example/abc')
    && frozen.reply.includes('€100')
    && frozen.tool_choice === frozen.tool_choice_baseline);

  ok('identity remains Luna', /Luna/.test((await harness.runTurn({
    tenant_id: 'sunset',
    case_id: 'invariant-identity-en',
    personality_id: 'extra',
  })).reply));

  const sendSrc = fs.existsSync(SEND_FLAGS)
    ? fs.readFileSync(SEND_FLAGS, 'utf8')
    : (fs.existsSync(SEND_FLAGS_ALT) ? fs.readFileSync(SEND_FLAGS_ALT, 'utf8') : '');
  ok('no-send path does not flip kill switches',
    !/LUNA_AUTO_SEND_ENABLED\s*=\s*['"]true['"]/.test(fs.readFileSync(MODULE_PATH, 'utf8'))
    && (sendSrc.length === 0 || /LUNA_AUTO_SEND_ENABLED|WHATSAPP_DRY_RUN/.test(sendSrc)));

  console.log(`\nverify:luna-personality-no-send: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
