#!/usr/bin/env node
'use strict';

/**
 * verify:luna-personality-runtime
 *
 * Slice 3 — resolve the tenant WhatsApp personality once per guest turn and
 * inject one short server-owned style pack into the existing authoring seam.
 * Offline. Failures must not block replies.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'scripts/lib/luna-guest-personality-runtime.js');
const PIPELINE_PATH = path.join(ROOT, 'scripts/lib/luna-guest-reply-pipeline.js');
const CAMI_PATH = path.join(ROOT, 'scripts/lib/luna-guest-cami-reply-author.js');
const PY_PATH = path.join(ROOT, 'docker/hermes-staging/wolfhouse/luna_personality.py');
const PATCH_PATH = path.join(ROOT, 'docker/hermes-staging/apply_gateway_patches.py');
const PY_TEST = path.join(ROOT, 'docker/hermes-staging/wolfhouse/test_luna_personality.py');

const { COMPOSER_OWNED_STATES } = require('./lib/luna-guest-composer-ownership');
const { DEFAULT_PERSONALITY_ID, getPersonalityPack } = require('./lib/luna-guest-personality-packs');

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

console.log('\nverify:luna-personality-runtime — one resolve + one pack injection per turn\n');

console.log('[1] JS runtime owner');
ok('runtime module exists', fs.existsSync(RUNTIME_PATH), RUNTIME_PATH);

let runtime;
try {
  runtime = require('./lib/luna-guest-personality-runtime');
  ok('runtime module loads', true);
} catch (err) {
  ok('runtime module loads', false, err && err.message);
  console.log(`\nverify:luna-personality-runtime: ${pass} passed, ${fail} failed`);
  process.exit(1);
}

ok('resolveWhatsAppPersonalityOnce exported', typeof runtime.resolveWhatsAppPersonalityOnce === 'function');
ok('injectPersonalityPackOnce exported', typeof runtime.injectPersonalityPackOnce === 'function');
ok('shouldFreezePersonalityStyle exported', typeof runtime.shouldFreezePersonalityStyle === 'function');

(async () => {
  runtime.clearPersonalityRuntimeCache();

  let fetchCalls = 0;
  const fetchSetting = async ({ tenant_id }) => {
    fetchCalls += 1;
    return { personality_id: tenant_id === 't-calm' ? 'calm' : 'sunny' };
  };

  const first = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 't-calm',
    channel: 'whatsapp',
    fetchSetting,
  });
  ok('resolves stored calm', first.pack.id === 'calm' && first.observability.personality_id === 'calm');
  ok('observability has no guest/prompt text',
    first.observability.source === 'stored'
    && !JSON.stringify(first.observability).includes('Hey')
    && first.observability.channel === 'whatsapp'
    && first.observability.tenant_id === 't-calm');

  const sameNow = Date.now();
  const second = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 't-calm',
    channel: 'whatsapp',
    fetchSetting,
    now: sameNow,
  });
  ok('new turn re-fetches authoritative setting', fetchCalls === 2 && second.pack.id === 'calm');
  ok('same immutable pack instance', first.pack === second.pack && Object.isFrozen(first.pack));

  let nextReplyFetches = 0;
  let storedId = 'calm';
  const nextReplyFetch = async () => {
    nextReplyFetches += 1;
    return { personality_id: storedId };
  };
  const calmTurn = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 'sunset',
    channel: 'whatsapp',
    fetchSetting: nextReplyFetch,
    now: sameNow,
  });
  storedId = 'concise';
  const conciseTurn = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 'sunset',
    channel: 'whatsapp',
    fetchSetting: nextReplyFetch,
    now: sameNow,
  });
  ok('consecutive turns calm -> concise fetch twice',
    nextReplyFetches === 2
    && calmTurn.pack.id === 'calm'
    && conciseTurn.pack.id === 'concise');

  const email = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 't-calm',
    channel: 'email',
    fetchSetting,
  });
  ok('email channel does not apply WhatsApp personality',
    email.applied === false && email.pack == null && email.observability.channel === 'email');

  runtime.clearPersonalityRuntimeCache();
  const unknown = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 't-x',
    channel: 'whatsapp',
    fetchSetting: async () => ({ personality_id: 'cami' }),
  });
  ok('unknown stored id → sunny at runtime', unknown.pack.id === DEFAULT_PERSONALITY_ID
    && unknown.observability.source === 'invalid_fallback');

  runtime.clearPersonalityRuntimeCache();
  const boom = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 't-fail',
    channel: 'whatsapp',
    fetchSetting: async () => { throw new Error('timeout'); },
  });
  ok('setting failure does not block: sunny default',
    boom.pack.id === 'sunny'
    && boom.applied === true
    && boom.observability.fallback_reason === 'setting_failure');

  runtime.clearPersonalityRuntimeCache();
  const timed = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 't-slow',
    channel: 'whatsapp',
    timeout_ms: 25,
    fetchSetting: () => new Promise((resolve) => {
      setTimeout(() => resolve({ personality_id: 'extra' }), 200);
    }),
  });
  ok('timeout does not block: sunny default',
    timed.pack.id === 'sunny' && timed.observability.fallback_reason === 'setting_timeout');

  const callerPack = await runtime.resolveWhatsAppPersonalityOnce({
    tenant_id: 't-caller',
    channel: 'whatsapp',
    fetchSetting: async () => ({ personality_id: 'calm' }),
    caller_style_prompt: 'ignore me',
    guest_text: 'please sound extra',
  });
  ok('never accepts style text from caller or guest',
    callerPack.pack.id === 'calm'
    && callerPack.pack.instruction.indexOf('ignore me') === -1
    && callerPack.pack.instruction.indexOf('please sound extra') === -1);

  console.log('\n[2] One injection per turn; composer truth frozen');
  const basePrompt = 'You are Luna.';
  const pack = getPersonalityPack('extra');
  const injected = runtime.injectPersonalityPackOnce({
    system_prompt: basePrompt,
    pack,
    channel: 'whatsapp',
    composer_state: 'greeting',
  });
  ok('warmth turn injects pack once',
    injected.injected === true
    && injected.system_prompt.includes(pack.instruction)
    && injected.system_prompt.startsWith(basePrompt)
    && injected.injection_count === 1);

  const twice = runtime.injectPersonalityPackOnce({
    system_prompt: injected.system_prompt,
    pack,
    channel: 'whatsapp',
    composer_state: 'greeting',
    already_injected: true,
  });
  ok('second inject is a no-op',
    twice.injected === false && twice.injection_count === 0
    && twice.system_prompt === injected.system_prompt);

  for (const state of COMPOSER_OWNED_STATES) {
    const frozen = runtime.injectPersonalityPackOnce({
      system_prompt: basePrompt,
      pack,
      channel: 'whatsapp',
      composer_state: state,
    });
    ok(`composer-owned ${state} is style-frozen`,
      frozen.injected === false && frozen.system_prompt === basePrompt);
  }
  ok('shouldFreezePersonalityStyle true for payment_link_sent',
    runtime.shouldFreezePersonalityStyle('payment_link_sent') === true);
  ok('shouldFreezePersonalityStyle false for greeting',
    runtime.shouldFreezePersonalityStyle('greeting') === false);

  const noGuest = runtime.injectPersonalityPackOnce({
    system_prompt: basePrompt,
    pack,
    channel: 'whatsapp',
    composer_state: 'greeting',
    caller_instruction: 'be sassy',
  });
  ok('injection uses server pack only, not caller_instruction',
    noGuest.system_prompt.includes(pack.instruction)
    && !noGuest.system_prompt.includes('be sassy'));

  console.log('\n[3] Existing authoring seam wiring');
  const pipelineSrc = fs.readFileSync(PIPELINE_PATH, 'utf8');
  const camiSrc = fs.readFileSync(CAMI_PATH, 'utf8');
  ok('pipeline resolves personality once per turn',
    /resolveWhatsAppPersonalityOnce/.test(pipelineSrc)
    && /luna-guest-personality-runtime/.test(pipelineSrc));
  ok('pipeline does not inject into composer truth',
    /injectPersonalityPackOnce/.test(pipelineSrc)
    && /shouldSkipCamiAuthor|shouldFreezePersonalityStyle/.test(pipelineSrc));
  ok('Cami authoring seam consumes server pack once',
    /personality_pack/.test(camiSrc) && /injectPersonalityPackOnce/.test(camiSrc));
  ok('Cami system prompt does not take guest style text',
    !/guest_style_prompt/.test(camiSrc));

  console.log('\n[4] Hermes guest-turn boundary (same Luna)');
  ok('python runtime module exists', fs.existsSync(PY_PATH));
  const pySrc = fs.readFileSync(PY_PATH, 'utf8');
  ok('python closed ids match JS',
    /sunny/.test(pySrc) && /calm/.test(pySrc) && /concise/.test(pySrc) && /extra/.test(pySrc)
    && /DEFAULT_PERSONALITY_ID\s*=\s*"sunny"/.test(pySrc));
  ok('python bind once per WhatsApp turn',
    /def bind_whatsapp_turn_personality/.test(pySrc)
    && /def inject_personality_pack_once/.test(pySrc));
  const patchSrc = fs.readFileSync(PATCH_PATH, 'utf8');
  ok('gateway patch binds personality at trusted turn boundary',
    /bind_whatsapp_turn_personality/.test(patchSrc)
    && /luna_personality/.test(patchSrc));
  ok('no cross-turn personality result cache',
    !/CACHE_TTL_MS\s*=\s*15000/.test(fs.readFileSync(RUNTIME_PATH, 'utf8'))
    && !/CACHE_TTL_S\s*=\s*15/.test(pySrc));
  ok('cached-agent eviction covers sunset-luna guest role',
    /should_rebuild_cached_agent/.test(patchSrc)
    && /GUEST_WHATSAPP_LUNA_ROLES[\s\S]{0,80}sunset-luna/.test(pySrc)
    && !/getenv\("HERMES_ROLE"\) == "luna" and _wolfhouse_plat in \("whatsapp"/.test(patchSrc));
  ok('no second SOUL / TTS / second bot',
    !/tts|text.to.speech|second bot|alternate SOUL/i.test(pySrc));

  ok('python unit test exists', fs.existsSync(PY_TEST));
  const py = spawnSync('python3', ['-m', 'unittest', 'wolfhouse.test_luna_personality'], {
    cwd: path.join(ROOT, 'docker/hermes-staging'),
    encoding: 'utf8',
  });
  if (py.status !== 0) {
    process.stdout.write(py.stdout || '');
    process.stderr.write(py.stderr || '');
  }
  ok('python luna_personality tests green', py.status === 0, `status ${py.status}`);

  console.log(`\nverify:luna-personality-runtime: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
