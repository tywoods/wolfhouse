'use strict';

/**
 * Deterministic verifier for Crowsnest AI usage source instrumentation (Slice 4).
 * Pure offline checks — no network, no DB, no storage writes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-ai-usage-source');
const PROVIDER_REL = 'scripts/lib/luna-ai-provider.js';
const PROVIDER_PATH = path.join(ROOT, PROVIDER_REL);
const OBSERVER_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-observer.js';
const OBSERVER_PATH = path.join(ROOT, OBSERVER_REL);
const ADAPTER_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-adapter.js';
const ADAPTER_PATH = path.join(ROOT, ADAPTER_REL);
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'AI-USAGE-SOURCE.md');
const PRODUCT_DOC_PATH = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const VERIFY_SCRIPT_REL = 'scripts/verify-crowsnest-ai-usage-source.js';

const PROVIDER_FIXTURES = Object.freeze([
  'openai-response-measured.json',
  'anthropic-response-measured.json',
  'openai-response-partial-usage.json',
  'openai-response-inconsistent-usage.json',
  'openai-http-429-body.json',
  'anthropic-http-500-body.json',
]);

const PRODUCTION_CALLERS = Object.freeze([
  'scripts/lib/staff-ask-luna-ai-intent.js',
  'scripts/lib/staff-ask-luna-ai-answer-format.js',
  'scripts/lib/staff-ask-luna-multi-tool-planner.js',
  'scripts/lib/staff-customer-outreach-draft-generate.js',
  'scripts/lib/owner-sql-planner.js',
  'scripts/lib/owner-command-center-answer.js',
  'scripts/lib/owner-insight-agent-live.js',
  'scripts/lib/luna-guest-frontdesk-planner.js',
  'scripts/lib/luna-guest-gpt-tool-planner.js',
  'scripts/lib/luna-guest-gpt-write-tool-planner.js',
  'scripts/lib/luna-guest-cami-reply-author.js',
  'scripts/lib/luna-conversation-brain.js',
]);

const BASE_TRUSTED = Object.freeze({
  client_slug: 'trusted-example-client',
  tenant_id: 'tenant_trusted_alpha',
  source_service: 'example-front-desk',
  operation: 'chat.completion',
  event_id: 'evt_source_synth_001',
  occurred_at: '2026-07-21T15:30:00.000Z',
});

const LEAK_NEEDLES = Object.freeze([
  'SECRET_SHOULD_NOT_LEAK',
  'guest@example.test',
  '+15550100',
  'sk-EXAMPLEFAKESECRETVALUE0001',
  'Bearer EXAMPLETOKENVALUE01',
  'chatcmpl-SYNTHETIC-OPENAI-001',
  'msg_SYNTHETIC_ANTHROPIC_001',
  'ignore me',
  'attacker-client-from-provider',
  'attacker-tenant-from-provider',
  'provider-spoofed-client',
  'provider-spoofed-tenant',
]);

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectStringLeaves(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStringLeaves(item, out);
    return out;
  }
  if (node != null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      collectStringLeaves(value, out);
    }
  }
  return out;
}

function hasAnySubstring(blob, needles) {
  return needles.some((n) => blob.includes(n));
}

function deleteProtoKeys(keys) {
  for (const key of keys) {
    try {
      delete Object.prototype[key];
    } catch (_) {
      /* ignore */
    }
  }
}

function protoHasOwn(key) {
  return Object.prototype.hasOwnProperty.call(Object.prototype, key);
}

function makeClock(startMs, endMs) {
  let calls = 0;
  return function nowMs() {
    calls += 1;
    return calls === 1 ? startMs : endMs;
  };
}

function makeJsonResponse(status, bodyObj) {
  if (typeof bodyObj === 'string') {
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return bodyObj;
      },
      async json() {
        return JSON.parse(bodyObj);
      },
    };
  }
  // Preserve object identity (including accessors) for security tests.
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(bodyObj);
    },
    async json() {
      return bodyObj;
    },
  };
}

console.log('verify:crowsnest-ai-usage-source — AI usage source instrumentation gate\n');

ok('provider module path exists', fs.existsSync(PROVIDER_PATH), PROVIDER_REL);
ok('observer module path exists', fs.existsSync(OBSERVER_PATH), OBSERVER_REL);
ok('adapter module path exists', fs.existsSync(ADAPTER_PATH), ADAPTER_REL);
ok('contract module path exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
ok('docs/crowsnest/AI-USAGE-SOURCE.md exists', fs.existsSync(DOC_PATH));
ok('docs/CROWSNEST.md exists', fs.existsSync(PRODUCT_DOC_PATH));
ok('verifier script path is this file', path.basename(__filename) === 'verify-crowsnest-ai-usage-source.js');

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
} catch {
  pkg = null;
}
ok('package.json parses', pkg != null);
ok(
  'package.json has verify:crowsnest-ai-usage-source',
  Boolean(pkg && pkg.scripts && pkg.scripts['verify:crowsnest-ai-usage-source']),
);
ok(
  'verify script points at verifier',
  Boolean(
    pkg
    && pkg.scripts
    && String(pkg.scripts['verify:crowsnest-ai-usage-source']).includes(VERIFY_SCRIPT_REL),
  ),
);

const onDiskFixtures = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort()
  : [];
const declaredFixtures = PROVIDER_FIXTURES.slice().sort();
ok(
  'fixture directory inventory equals declared provider fixture set',
  declaredFixtures.length === onDiskFixtures.length
    && declaredFixtures.every((name, i) => name === onDiskFixtures[i]),
  `declared=[${declaredFixtures.join(',')}] disk=[${onDiskFixtures.join(',')}]`,
);

for (const name of PROVIDER_FIXTURES) {
  const abs = path.join(FIXTURE_DIR, name);
  ok(`fixture exists ${name}`, fs.existsSync(abs));
  if (fs.existsSync(abs)) {
    try {
      readJson(abs);
      ok(`fixture parses ${name}`, true);
    } catch (err) {
      ok(`fixture parses ${name}`, false, String(err.message || err));
    }
  } else {
    ok(`fixture parses ${name}`, false, 'missing');
  }
}

let provider = null;
let observerMod = null;
let adapter = null;
let contract = null;
let loadError = null;
try {
  delete require.cache[require.resolve(CONTRACT_PATH)];
  contract = require(CONTRACT_PATH);
  delete require.cache[require.resolve(ADAPTER_PATH)];
  adapter = require(ADAPTER_PATH);
  if (fs.existsSync(OBSERVER_PATH)) {
    delete require.cache[require.resolve(OBSERVER_PATH)];
    observerMod = require(OBSERVER_PATH);
  }
  delete require.cache[require.resolve(PROVIDER_PATH)];
  provider = require(PROVIDER_PATH);
} catch (err) {
  loadError = err;
}

ok('provider module loads', provider != null, loadError ? String(loadError.message || loadError) : '');
ok(
  'exports callLunaAiJsonChat',
  Boolean(provider && typeof provider.callLunaAiJsonChat === 'function'),
);
ok('observer module loads', observerMod != null, loadError ? String(loadError.message || loadError) : '');
ok(
  'exports emitCrowsnestAiUsageFromObservation',
  Boolean(observerMod && typeof observerMod.emitCrowsnestAiUsageFromObservation === 'function'),
);

const callLunaAiJsonChat = provider && typeof provider.callLunaAiJsonChat === 'function'
  ? provider.callLunaAiJsonChat
  : null;
const emitObservation = observerMod && typeof observerMod.emitCrowsnestAiUsageFromObservation === 'function'
  ? observerMod.emitCrowsnestAiUsageFromObservation
  : null;
const validate = contract && typeof contract.validateCrowsnestAiUsageEvent === 'function'
  ? contract.validateCrowsnestAiUsageEvent
  : null;

const providerSrc = fs.existsSync(PROVIDER_PATH) ? fs.readFileSync(PROVIDER_PATH, 'utf8') : '';
ok(
  'provider documents optional onUsageObservation',
  /onUsageObservation/.test(providerSrc),
);
ok(
  'provider does not require crowsnest observer module',
  !/crowsnest-ai-usage-observer/.test(providerSrc),
);
ok(
  'provider does not require crowsnest adapter',
  !/crowsnest-ai-usage-adapter/.test(providerSrc),
);

// Prove production callers do not pass the observer (runtime remains disabled).
// Also guard spread-forwarding risk: call sites must not forward unknown opts keys
// (e.g. ...opts) into callLunaAiJsonChat; local spreads must be allowlisted literals.
const PROVIDER_CALL_OPT_ALLOWLIST = Object.freeze([
  'system',
  'user',
  'env',
  'maxTokens',
  'temperature',
  'jsonObject',
  'call_label',
  'fetchImpl',
  'model',
  'provider',
  'apiKey',
]);

function extractCallLunaAiJsonChatArgBlocks(src) {
  return extractNamedCallArgBlocks(src, ['callLunaAiJsonChat']);
}

function collectSpreadIdents(block) {
  const idents = [];
  const re = /\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    idents.push(m[1]);
  }
  return idents;
}

function localObjectLiteralKeys(src, ident) {
  const re = new RegExp(
    `\\b(?:const|let|var)\\s+${ident}\\s*=\\s*\\{([\\s\\S]*?)\\};`,
  );
  const m = src.match(re);
  if (!m) return null;
  const body = m[1];
  const keys = [];
  const keyRe = /(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  let km;
  while ((km = keyRe.exec(body)) !== null) {
    keys.push(km[1]);
  }
  return keys;
}

function extractNamedCallArgBlocks(src, names) {
  const blocks = [];
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*\\(\\s*\\{`, 'g');
    let match;
    while ((match = re.exec(src)) !== null) {
      let i = match.index + match[0].length - 1;
      let depth = 0;
      const start = i;
      for (; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            blocks.push(src.slice(start, i + 1));
            break;
          }
        }
      }
    }
  }
  return blocks;
}

for (const rel of PRODUCTION_CALLERS) {
  const abs = path.join(ROOT, rel);
  ok(`production caller exists ${rel}`, fs.existsSync(abs));
  if (fs.existsSync(abs)) {
    const src = fs.readFileSync(abs, 'utf8');
    ok(
      `production caller does not pass onUsageObservation (${path.basename(rel)})`,
      !/\bonUsageObservation\b/.test(src),
    );
    const directBlocks = extractCallLunaAiJsonChatArgBlocks(src);
    const indirectBlocks = extractNamedCallArgBlocks(src, ['caller', 'aiCaller']);
    const blocks = directBlocks.length > 0 ? directBlocks : indirectBlocks;
    ok(
      `production caller has provider call object args (${path.basename(rel)})`,
      blocks.length > 0,
    );
    for (let bi = 0; bi < blocks.length; bi += 1) {
      const block = blocks[bi];
      ok(
        `production caller does not spread opts/options into provider (${path.basename(rel)}#${bi})`,
        !/\.\.\.\s*(opts|options)\b/.test(block),
      );
      const spreads = collectSpreadIdents(block).filter((id) => id !== 'env' && id !== 'e');
      for (const ident of spreads) {
        if (ident === 'modelOverride' || ident === 'providerOverride') {
          ok(
            `production caller conditional spread ${ident} is allowlisted (${path.basename(rel)}#${bi})`,
            true,
          );
          continue;
        }
        const keys = localObjectLiteralKeys(src, ident);
        ok(
          `production caller spread source ${ident} is local literal (${path.basename(rel)}#${bi})`,
          Array.isArray(keys),
        );
        if (Array.isArray(keys)) {
          ok(
            `production caller spread source ${ident} has no onUsageObservation (${path.basename(rel)}#${bi})`,
            !keys.includes('onUsageObservation'),
          );
          ok(
            `production caller spread source ${ident} keys are allowlisted (${path.basename(rel)}#${bi})`,
            keys.every((k) => PROVIDER_CALL_OPT_ALLOWLIST.includes(k)),
            keys.join(','),
          );
        }
      }
    }
  }
}

async function main() {
if (callLunaAiJsonChat && emitObservation && validate) {
  const openaiMeasured = readJson(path.join(FIXTURE_DIR, 'openai-response-measured.json'));
  const anthropicMeasured = readJson(path.join(FIXTURE_DIR, 'anthropic-response-measured.json'));
  const openaiPartial = readJson(path.join(FIXTURE_DIR, 'openai-response-partial-usage.json'));
  const openaiInconsistent = readJson(path.join(FIXTURE_DIR, 'openai-response-inconsistent-usage.json'));
  const openai429Body = readJson(path.join(FIXTURE_DIR, 'openai-http-429-body.json'));
  const anthropic500Body = readJson(path.join(FIXTURE_DIR, 'anthropic-http-500-body.json'));

  const baseEnv = {
    LUNA_AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-source-instrumentation-key-0001',
    LUNA_AI_MODEL: 'gpt-example-mini',
  };

  // ── Default no-op: no observer → return text unchanged, no crash ─────────
  {
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    const text = await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys SECRET_SHOULD_NOT_LEAK',
      user: 'user guest@example.test +15550100',
      fetchImpl,
      call_label: 'source_test_default',
      nowMs: makeClock(1000, 1318),
    });
    ok(
      'default (no observer) returns assistant text',
      text === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
  }

  // ── Disabled provider returns null, no observation ───────────────────────
  {
    const snapshots = [];
    const text = await callLunaAiJsonChat({
      env: {},
      system: 'sys',
      user: 'user',
      onUsageObservation: (snap) => { snapshots.push(snap); },
      nowMs: makeClock(1, 2),
    });
    ok('disabled provider returns null', text === null);
    ok('disabled provider does not invoke observer', snapshots.length === 0);
  }

  // ── OpenAI measured success observation ──────────────────────────────────
  {
    const snapshots = [];
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    const text = await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys SECRET_SHOULD_NOT_LEAK',
      user: 'user guest@example.test',
      fetchImpl,
      call_label: 'source_openai_measured',
      nowMs: makeClock(1000, 1318),
      onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
    });
    ok(
      'openai measured returns unchanged text',
      text === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
    ok('openai measured emits one snapshot', snapshots.length === 1);
    const snap = snapshots[0] || {};
    ok('openai snapshot status succeeded', snap.status === 'succeeded');
    ok('openai snapshot provider', snap.provider === 'openai');
    ok('openai snapshot request_model', snap.request_model === 'gpt-example-mini');
    ok('openai snapshot response_model', snap.response_model === 'gpt-example-mini');
    ok('openai snapshot latency_ms', snap.latency_ms === 318);
    ok('openai snapshot call_label', snap.call_label === 'source_openai_measured');
    ok(
      'openai snapshot usage own-data measured',
      Boolean(
        snap.usage
        && snap.usage.prompt_tokens === 42
        && snap.usage.completion_tokens === 17
        && snap.usage.total_tokens === 59,
      ),
    );
    ok('openai snapshot has no error_code', !Object.prototype.hasOwnProperty.call(snap, 'error_code'));
    const snapBlob = JSON.stringify(snap);
    ok(
      'openai snapshot does not leak content/PII/ids/secrets',
      !hasAnySubstring(snapBlob, LEAK_NEEDLES),
      snapBlob.slice(0, 200),
    );
    ok(
      'openai snapshot forbids content keys',
      !hasAnySubstring(snapBlob, ['"choices"', '"content"', '"messages"', '"prompt"', '"api_key"']),
    );

    const events = [];
    const emit = emitObservation({
      ...BASE_TRUSTED,
      event_id: 'evt_source_openai_ok',
      observation: snap,
      onEvent: (event) => { events.push(deepClone(event)); },
    });
    ok('openai helper emit ok', Boolean(emit && emit.ok === true));
    ok('openai helper forwarded one event', events.length === 1);
    if (events[0]) {
      const v = validate(events[0]);
      ok('openai adapted event passes contract', v.ok === true, v.errors ? v.errors.join('; ') : '');
      ok('openai adapted event measured tokens', events[0].tokens && events[0].tokens.availability === 'measured');
      ok(
        'openai adapted event uses trusted identity not provider spoof',
        events[0].client_slug === BASE_TRUSTED.client_slug
          && events[0].tenant_id === BASE_TRUSTED.tenant_id,
      );
      ok(
        'openai adapted event does not leak content',
        !hasAnySubstring(JSON.stringify(events[0]), LEAK_NEEDLES),
      );
    }
  }

  // ── Anthropic measured success observation ───────────────────────────────
  {
    const snapshots = [];
    const env = {
      LUNA_AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-source-instrumentation-0001',
      LUNA_AI_MODEL: 'claude-example-haiku',
    };
    const fetchImpl = async () => makeJsonResponse(200, deepClone(anthropicMeasured));
    const text = await callLunaAiJsonChat({
      env,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_anthropic_measured',
      nowMs: makeClock(5000, 5125),
      onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
    });
    ok(
      'anthropic measured returns unchanged text',
      text === 'SECRET_SHOULD_NOT_LEAK booking transcript and Bearer EXAMPLETOKENVALUE01',
    );
    ok('anthropic measured emits one snapshot', snapshots.length === 1);
    const snap = snapshots[0] || {};
    ok('anthropic snapshot status succeeded', snap.status === 'succeeded');
    ok('anthropic snapshot provider', snap.provider === 'anthropic');
    ok('anthropic snapshot response_model', snap.response_model === 'claude-example-haiku');
    ok('anthropic snapshot latency_ms', snap.latency_ms === 125);
    ok(
      'anthropic snapshot usage own-data',
      Boolean(snap.usage && snap.usage.input_tokens === 100 && snap.usage.output_tokens === 25),
    );
    ok(
      'anthropic snapshot does not leak content',
      !hasAnySubstring(JSON.stringify(snap), LEAK_NEEDLES),
    );

    const events = [];
    const emit = emitObservation({
      ...BASE_TRUSTED,
      event_id: 'evt_source_anthropic_ok',
      observation: snap,
      onEvent: (event) => { events.push(deepClone(event)); },
    });
    ok('anthropic helper emit ok', Boolean(emit && emit.ok === true));
    ok('anthropic helper forwarded one event', events.length === 1);
    if (events[0]) {
      const v = validate(events[0]);
      ok('anthropic adapted event passes contract', v.ok === true, v.errors ? v.errors.join('; ') : '');
      ok(
        'anthropic adapted measured total is input+output',
        events[0].tokens
          && events[0].tokens.availability === 'measured'
          && events[0].tokens.total_tokens === 125,
      );
    }
  }

  // ── Malformed / partial usage still returns text; adapter yields unavailable ─
  {
    const snapshots = [];
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiPartial));
    const text = await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_partial',
      nowMs: makeClock(10, 20),
      onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
    });
    ok('partial usage still returns string', typeof text === 'string');
    ok('partial usage emits snapshot', snapshots.length === 1);

    const events = [];
    const emit = emitObservation({
      ...BASE_TRUSTED,
      event_id: 'evt_source_partial',
      observation: snapshots[0],
      onEvent: (event) => { events.push(event); },
    });
    ok('partial usage helper emit ok', Boolean(emit && emit.ok === true));
    ok(
      'partial usage adapted tokens unavailable',
      Boolean(events[0] && events[0].tokens && events[0].tokens.availability === 'unavailable'),
    );
  }

  {
    const snapshots = [];
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiInconsistent));
    await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_inconsistent',
      nowMs: makeClock(10, 30),
      onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
    });
    const events = [];
    emitObservation({
      ...BASE_TRUSTED,
      event_id: 'evt_source_inconsistent',
      observation: snapshots[0],
      onEvent: (event) => { events.push(event); },
    });
    ok(
      'inconsistent usage adapted tokens unavailable',
      Boolean(events[0] && events[0].tokens && events[0].tokens.availability === 'unavailable'),
    );
  }

  // ── Provider HTTP failure: throw preserved; opaque error_code only ───────
  {
    const snapshots = [];
    const fetchImpl = async () => makeJsonResponse(429, deepClone(openai429Body));
    let thrown = null;
    try {
      await callLunaAiJsonChat({
        env: baseEnv,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_openai_fail',
        nowMs: makeClock(100, 250),
        onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
      });
    } catch (err) {
      thrown = err;
    }
    ok('openai 429 still throws', thrown != null);
    ok('openai 429 throws LunaAiHttpError', thrown && thrown.name === 'LunaAiHttpError');
    ok('openai 429 emits one failure snapshot', snapshots.length === 1);
    const snap = snapshots[0] || {};
    ok('openai 429 snapshot status failed', snap.status === 'failed');
    ok('openai 429 opaque error_code', snap.error_code === 'http_429');
    ok('openai 429 latency_ms', snap.latency_ms === 150);
    ok(
      'openai 429 snapshot does not leak raw error text',
      !hasAnySubstring(JSON.stringify(snap), LEAK_NEEDLES.concat(['rate_limit_exceeded', 'Rate limit'])),
    );

    const events = [];
    const emit = emitObservation({
      ...BASE_TRUSTED,
      event_id: 'evt_source_openai_fail',
      observation: snap,
      onEvent: (event) => { events.push(deepClone(event)); },
    });
    ok('openai failure helper emit ok', Boolean(emit && emit.ok === true));
    ok(
      'openai failure event has opaque error_code',
      Boolean(events[0] && events[0].status === 'failed' && events[0].error_code === 'http_429'),
    );
    ok(
      'openai failure event tokens unavailable',
      Boolean(events[0] && events[0].tokens && events[0].tokens.availability === 'unavailable'),
    );
  }

  {
    const snapshots = [];
    const env = {
      LUNA_AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-source-instrumentation-0001',
      LUNA_AI_MODEL: 'claude-example-haiku',
    };
    const fetchImpl = async () => makeJsonResponse(500, deepClone(anthropic500Body));
    let thrown = null;
    try {
      await callLunaAiJsonChat({
        env,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_anthropic_fail',
        nowMs: makeClock(1, 9),
        onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
      });
    } catch (err) {
      thrown = err;
    }
    ok('anthropic 500 still throws', thrown != null);
    ok('anthropic 500 snapshot error_code', snapshots[0] && snapshots[0].error_code === 'http_500');
    ok(
      'anthropic 500 snapshot no raw error leak',
      !hasAnySubstring(JSON.stringify(snapshots[0] || {}), LEAK_NEEDLES.concat(['api_error', 'internal failure'])),
    );
  }

  // ── Observer failure isolation ───────────────────────────────────────────
  {
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    const text = await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_observer_throws',
      nowMs: makeClock(1, 2),
      onUsageObservation: () => {
        throw new Error('observer boom SECRET_SHOULD_NOT_LEAK');
      },
    });
    ok(
      'observer throw does not alter success return',
      text === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
  }

  {
    const fetchImpl = async () => makeJsonResponse(429, deepClone(openai429Body));
    let thrown = null;
    try {
      await callLunaAiJsonChat({
        env: baseEnv,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_observer_throws_on_fail',
        nowMs: makeClock(1, 2),
        onUsageObservation: () => {
          throw new Error('observer boom on failure');
        },
      });
    } catch (err) {
      thrown = err;
    }
    ok('observer throw does not swallow provider throw', thrown != null && thrown.name === 'LunaAiHttpError');
  }

  // ── Async / thenable observer + sink isolation (no unhandledRejection) ───
  async function withUnhandledRejectionProbe(run) {
    const seen = [];
    const onUnhandled = (reason) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await run();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return { result, unhandled: seen.slice() };
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  }

  {
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    const probed = await withUnhandledRejectionProbe(async () => callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_observer_async_reject',
      nowMs: makeClock(1, 2),
      onUsageObservation: async () => {
        throw new Error('async observer boom');
      },
    }));
    ok(
      'async observer reject preserves success return',
      probed.result === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
    ok('async observer reject causes no unhandledRejection', probed.unhandled.length === 0);
  }

  {
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    const probed = await withUnhandledRejectionProbe(async () => callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_observer_promise_reject',
      nowMs: makeClock(1, 2),
      onUsageObservation: () => Promise.reject(new Error('promise observer boom')),
    }));
    ok(
      'Promise.reject observer preserves success return',
      probed.result === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
    ok('Promise.reject observer causes no unhandledRejection', probed.unhandled.length === 0);
  }

  {
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    const probed = await withUnhandledRejectionProbe(async () => callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_observer_thenable_reject',
      nowMs: makeClock(1, 2),
      onUsageObservation: () => ({
        then(_resolve, reject) {
          reject(new Error('thenable observer boom'));
        },
      }),
    }));
    ok(
      'thenable observer reject preserves success return',
      probed.result === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
    ok('thenable observer reject causes no unhandledRejection', probed.unhandled.length === 0);
  }

  {
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    const probed = await withUnhandledRejectionProbe(async () => callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_observer_hostile_then',
      nowMs: makeClock(1, 2),
      onUsageObservation: () => ({
        get then() {
          throw new Error('hostile then accessor');
        },
      }),
    }));
    ok(
      'hostile then accessor observer preserves success return',
      probed.result === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
    ok('hostile then accessor observer causes no unhandledRejection', probed.unhandled.length === 0);
  }

  {
    const goodSnap = {
      provider: 'openai',
      request_model: 'gpt-example-mini',
      response_model: 'gpt-example-mini',
      status: 'succeeded',
      latency_ms: 10,
      call_label: 'callback_async',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const probed = await withUnhandledRejectionProbe(async () => {
      let threw = false;
      let result = null;
      try {
        result = emitObservation({
          ...BASE_TRUSTED,
          event_id: 'evt_callback_async',
          observation: goodSnap,
          onEvent: async () => {
            throw new Error('async sink boom');
          },
        });
      } catch (_) {
        threw = true;
      }
      return { threw, result };
    });
    ok('async onEvent still returns ok from helper', Boolean(probed.result.result && probed.result.result.ok === true));
    ok('async onEvent does not escape helper', probed.result.threw === false);
    ok('async onEvent causes no unhandledRejection', probed.unhandled.length === 0);
  }

  {
    const goodSnap = {
      provider: 'openai',
      request_model: 'gpt-example-mini',
      response_model: 'gpt-example-mini',
      status: 'succeeded',
      latency_ms: 10,
      call_label: 'callback_promise',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const probed = await withUnhandledRejectionProbe(async () => emitObservation({
      ...BASE_TRUSTED,
      event_id: 'evt_callback_promise',
      observation: goodSnap,
      onEvent: () => Promise.reject(new Error('promise sink boom')),
    }));
    ok('Promise.reject onEvent still returns ok', Boolean(probed.result && probed.result.ok === true));
    ok('Promise.reject onEvent causes no unhandledRejection', probed.unhandled.length === 0);
  }

  // ── Observer omitted: no nowMs, no snapshot construction side effects ────
  {
    let nowCalls = 0;
    const hostileBody = new Proxy(deepClone(openaiMeasured), {
      getPrototypeOf() {
        throw new Error('getPrototypeOf boom during snapshot');
      },
    });
    const fetchImpl = async () => makeJsonResponse(200, hostileBody);
    let thrown = null;
    let text = null;
    try {
      text = await callLunaAiJsonChat({
        env: baseEnv,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_no_observer_hostile_proto',
        nowMs: () => {
          nowCalls += 1;
          return Date.now();
        },
      });
    } catch (err) {
      thrown = err;
    }
    ok(
      'observer omitted: hostile getPrototypeOf does not alter success return',
      thrown == null
        && text === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
    ok('observer omitted: injected nowMs is not called', nowCalls === 0);
  }

  {
    let nowCalls = 0;
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_no_observer_nowms',
      nowMs: () => {
        nowCalls += 1;
        return 42;
      },
    });
    ok('observer omitted: nowMs unused on happy path', nowCalls === 0);
  }

  // ── Clock isolation: start throw + end throw fallback ────────────────────
  {
    const snapshots = [];
    let calls = 0;
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    let text = null;
    let startThrew = null;
    try {
      text = await callLunaAiJsonChat({
        env: baseEnv,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_nowms_start_throws',
        nowMs: () => {
          calls += 1;
          if (calls === 1) throw new Error('start clock boom');
          return 5000;
        },
        onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
      });
    } catch (err) {
      startThrew = err;
    }
    ok(
      'start nowMs throw does not abort success return',
      startThrew == null
        && text === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
    ok('start nowMs throw still emits snapshot', snapshots.length === 1);
    ok('start nowMs throw yields deterministic latency_ms 0', snapshots[0] && snapshots[0].latency_ms === 0);
  }

  {
    const snapshots = [];
    let calls = 0;
    const fetchImpl = async () => makeJsonResponse(200, deepClone(openaiMeasured));
    const text = await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_nowms_end_throws',
      nowMs: () => {
        calls += 1;
        if (calls === 1) return 1000;
        throw new Error('end clock boom');
      },
      onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
    });
    ok(
      'end nowMs throw does not abort success return',
      text === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
    ok('end nowMs throw yields deterministic latency_ms 0', snapshots[0] && snapshots[0].latency_ms === 0);
  }

  // Snapshot construction failures inside observer boundary must not alter AI path
  {
    const fetchImpl = async () => {
      const body = deepClone(openaiMeasured);
      return makeJsonResponse(200, new Proxy(body, {
        getPrototypeOf() {
          throw new Error('snapshot proto boom with observer');
        },
      }));
    };
    let text = null;
    let boomThrew = null;
    try {
      text = await callLunaAiJsonChat({
        env: baseEnv,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_observer_snapshot_proto_boom',
        nowMs: makeClock(1, 2),
        onUsageObservation: () => {
          throw new Error('should not matter');
        },
      });
    } catch (err) {
      boomThrew = err;
    }
    ok(
      'snapshot getPrototypeOf boom isolated with observer present',
      boomThrew == null
        && text === 'SECRET_SHOULD_NOT_LEAK guest phone +15550100 and email guest@example.test',
    );
  }

  // ── Network reject + response.json parse reject (exact throw identity) ───
  {
    const snapshots = [];
    const netErr = Object.assign(new Error('SYNTHETIC_NETWORK_DOWN'), { code: 'ECONNRESET' });
    const fetchImpl = async () => {
      throw netErr;
    };
    let thrown = null;
    try {
      await callLunaAiJsonChat({
        env: baseEnv,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_network_reject',
        nowMs: makeClock(10, 40),
        onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
      });
    } catch (err) {
      thrown = err;
    }
    ok('fetch network reject preserves exact thrown object', thrown === netErr);
    ok('fetch network reject emits one snapshot', snapshots.length === 1);
    ok(
      'fetch network reject opaque error_code',
      snapshots[0] && snapshots[0].error_code === 'provider_network_error',
    );
    ok(
      'fetch network reject snapshot does not leak network message',
      !hasAnySubstring(JSON.stringify(snapshots[0] || {}), ['SYNTHETIC_NETWORK_DOWN', 'ECONNRESET']),
    );
  }

  {
    const snapshots = [];
    const parseErr = Object.assign(new Error('SYNTHETIC_JSON_PARSE_FAIL'), { name: 'SyntaxError' });
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      async text() {
        return '{';
      },
      async json() {
        throw parseErr;
      },
    });
    let thrown = null;
    try {
      await callLunaAiJsonChat({
        env: baseEnv,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_json_parse_reject',
        nowMs: makeClock(5, 15),
        onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
      });
    } catch (err) {
      thrown = err;
    }
    ok('response.json reject preserves exact thrown object', thrown === parseErr);
    ok('response.json reject emits one snapshot', snapshots.length === 1);
    ok(
      'response.json reject opaque error_code',
      snapshots[0] && snapshots[0].error_code === 'provider_response_error',
    );
    ok(
      'response.json reject snapshot does not leak parse message',
      !hasAnySubstring(JSON.stringify(snapshots[0] || {}), ['SYNTHETIC_JSON_PARSE_FAIL']),
    );
  }

  // ── response.model accessor must not be invoked ──────────────────────────
  {
    let modelGets = 0;
    const snapshots = [];
    const response = deepClone(openaiMeasured);
    const modelValue = response.model;
    delete response.model;
    Object.defineProperty(response, 'model', {
      get() {
        modelGets += 1;
        return modelValue;
      },
      enumerable: true,
      configurable: true,
    });
    const fetchImpl = async () => makeJsonResponse(200, response);
    const text = await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_accessor_model',
      nowMs: makeClock(1, 2),
      onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
    });
    ok('accessor model still returns assistant text', typeof text === 'string' && text.length > 0);
    ok('accessor model getter was not invoked by observer snapshot', modelGets === 0);
    ok(
      'accessor model yields snapshot without response_model own-data',
      Boolean(snapshots[0] && !Object.prototype.hasOwnProperty.call(snapshots[0], 'response_model')),
    );
  }

  // ── Unsafe numeric usage values omitted (still adapt unavailable) ────────
  {
    const snapshots = [];
    const unsafe = deepClone(openaiMeasured);
    unsafe.usage = {
      prompt_tokens: -3,
      completion_tokens: Number.NaN,
      total_tokens: Number.POSITIVE_INFINITY,
    };
    const fetchImpl = async () => makeJsonResponse(200, unsafe);
    const text = await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_unsafe_usage_numbers',
      nowMs: makeClock(1, 2),
      onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
    });
    ok('unsafe usage numbers still return assistant text', typeof text === 'string' && text.length > 0);
    ok(
      'unsafe usage numbers omitted from snapshot',
      Boolean(snapshots[0] && !Object.prototype.hasOwnProperty.call(snapshots[0], 'usage')),
    );
    const events = [];
    const emit = emitObservation({
      ...BASE_TRUSTED,
      event_id: 'evt_source_unsafe_usage',
      observation: snapshots[0],
      onEvent: (event) => { events.push(event); },
    });
    ok('unsafe usage helper emit ok', Boolean(emit && emit.ok === true));
    ok(
      'unsafe usage adapted tokens unavailable',
      Boolean(events[0] && events[0].tokens && events[0].tokens.availability === 'unavailable'),
    );
  }

  // ── Helper: dual-identity fail-closed / no env / no provider spoof ───────
  {
    const goodSnap = {
      provider: 'openai',
      request_model: 'gpt-example-mini',
      response_model: 'gpt-example-mini',
      status: 'succeeded',
      latency_ms: 10,
      call_label: 'gate_test',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };

    const events = [];
    const missingClient = emitObservation({
      tenant_id: BASE_TRUSTED.tenant_id,
      source_service: BASE_TRUSTED.source_service,
      operation: BASE_TRUSTED.operation,
      event_id: 'evt_missing_client',
      occurred_at: BASE_TRUSTED.occurred_at,
      observation: goodSnap,
      onEvent: (e) => { events.push(e); },
    });
    ok('missing client_slug fails closed', Boolean(missingClient && missingClient.ok === false));
    ok('missing client_slug emits no event', events.length === 0);

    const missingTenant = emitObservation({
      client_slug: BASE_TRUSTED.client_slug,
      source_service: BASE_TRUSTED.source_service,
      operation: BASE_TRUSTED.operation,
      event_id: 'evt_missing_tenant',
      occurred_at: BASE_TRUSTED.occurred_at,
      observation: goodSnap,
      onEvent: (e) => { events.push(e); },
    });
    ok('missing tenant_id fails closed', Boolean(missingTenant && missingTenant.ok === false));
    ok('missing tenant_id emits no event', events.length === 0);
  }

  {
    const goodSnap = {
      provider: 'openai',
      request_model: 'gpt-example-mini',
      response_model: 'gpt-example-mini',
      status: 'succeeded',
      latency_ms: 10,
      call_label: 'env_spoof',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const prevClient = process.env.CROWSNEST_CLIENT_SLUG;
    const prevTenant = process.env.CROWSNEST_TENANT_ID;
    process.env.CROWSNEST_CLIENT_SLUG = 'env-spoofed-client';
    process.env.CROWSNEST_TENANT_ID = 'env-spoofed-tenant';
    try {
      const events = [];
      const result = emitObservation({
        source_service: BASE_TRUSTED.source_service,
        operation: BASE_TRUSTED.operation,
        event_id: 'evt_env_spoof',
        occurred_at: BASE_TRUSTED.occurred_at,
        observation: goodSnap,
        onEvent: (e) => { events.push(e); },
      });
      ok('env spoof without explicit identity fails closed', Boolean(result && result.ok === false));
      ok('env spoof emits no event', events.length === 0);
    } finally {
      if (prevClient === undefined) delete process.env.CROWSNEST_CLIENT_SLUG;
      else process.env.CROWSNEST_CLIENT_SLUG = prevClient;
      if (prevTenant === undefined) delete process.env.CROWSNEST_TENANT_ID;
      else process.env.CROWSNEST_TENANT_ID = prevTenant;
    }
  }

  {
    const events = [];
    const spoofSnap = {
      provider: 'openai',
      request_model: 'gpt-example-mini',
      response_model: 'gpt-example-mini',
      status: 'succeeded',
      latency_ms: 10,
      call_label: 'payload_spoof',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      client_slug: 'attacker-client-from-provider',
      tenant_id: 'attacker-tenant-from-provider',
    };
    const result = emitObservation({
      ...BASE_TRUSTED,
      event_id: 'evt_payload_spoof',
      observation: spoofSnap,
      onEvent: (e) => { events.push(deepClone(e)); },
    });
    ok('provider payload identity spoof ignored; emit still ok with trusted inputs', Boolean(result && result.ok === true));
    ok(
      'trusted identity wins over observation spoof',
      Boolean(
        events[0]
        && events[0].client_slug === BASE_TRUSTED.client_slug
        && events[0].tenant_id === BASE_TRUSTED.tenant_id,
      ),
    );
    ok(
      'spoofed identity strings absent from event',
      !hasAnySubstring(JSON.stringify(events[0] || {}), [
        'attacker-client-from-provider',
        'attacker-tenant-from-provider',
      ]),
    );
  }

  // ── Prototype / accessor attacks on trusted identity ─────────────────────
  {
    const goodSnap = {
      provider: 'openai',
      request_model: 'gpt-example-mini',
      response_model: 'gpt-example-mini',
      status: 'succeeded',
      latency_ms: 10,
      call_label: 'proto_test',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    try {
      Object.defineProperty(Object.prototype, 'client_slug', {
        value: 'proto-client',
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'tenant_id', {
        value: 'proto-tenant',
        configurable: true,
      });
      const events = [];
      const result = emitObservation({
        source_service: BASE_TRUSTED.source_service,
        operation: BASE_TRUSTED.operation,
        event_id: 'evt_proto_identity',
        occurred_at: BASE_TRUSTED.occurred_at,
        observation: goodSnap,
        onEvent: (e) => { events.push(e); },
      });
      ok(
        'Object.prototype identity pollution fails closed',
        Boolean(result && result.ok === false),
      );
      ok('prototype identity emits no event', events.length === 0);
    } finally {
      deleteProtoKeys(['client_slug', 'tenant_id']);
    }
    ok(
      'no Object.prototype pollution remains after identity test',
      !protoHasOwn('client_slug') && !protoHasOwn('tenant_id'),
    );
  }

  {
    let clientGets = 0;
    let tenantGets = 0;
    const goodSnap = {
      provider: 'openai',
      request_model: 'gpt-example-mini',
      response_model: 'gpt-example-mini',
      status: 'succeeded',
      latency_ms: 10,
      call_label: 'accessor_test',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const input = {
      source_service: BASE_TRUSTED.source_service,
      operation: BASE_TRUSTED.operation,
      event_id: 'evt_accessor_identity',
      occurred_at: BASE_TRUSTED.occurred_at,
      observation: goodSnap,
      onEvent: () => {},
    };
    Object.defineProperty(input, 'client_slug', {
      get() {
        clientGets += 1;
        return BASE_TRUSTED.client_slug;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(input, 'tenant_id', {
      get() {
        tenantGets += 1;
        return BASE_TRUSTED.tenant_id;
      },
      enumerable: true,
      configurable: true,
    });
    const result = emitObservation(input);
    ok('accessor trusted identity fails closed', Boolean(result && result.ok === false));
    ok('trusted identity getters did not execute', clientGets === 0 && tenantGets === 0);
  }

  // ── Callback failure isolation on helper ─────────────────────────────────
  {
    const goodSnap = {
      provider: 'openai',
      request_model: 'gpt-example-mini',
      response_model: 'gpt-example-mini',
      status: 'succeeded',
      latency_ms: 10,
      call_label: 'callback_boom',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    let threw = false;
    try {
      const result = emitObservation({
        ...BASE_TRUSTED,
        event_id: 'evt_callback_boom',
        observation: goodSnap,
        onEvent: () => {
          throw new Error('sink boom');
        },
      });
      ok('callback throw still returns ok from helper', Boolean(result && result.ok === true));
    } catch (_) {
      threw = true;
    }
    ok('callback throw does not escape helper', threw === false);
  }

  // ── Observation usage accessor / prototype: no fabricated measured fields ─
  {
    const snapshots = [];
    const polluted = deepClone(openaiMeasured);
    delete polluted.usage.prompt_tokens;
    delete polluted.usage.completion_tokens;
    delete polluted.usage.total_tokens;
    try {
      Object.defineProperty(Object.prototype, 'prompt_tokens', {
        value: 999,
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'completion_tokens', {
        value: 999,
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'total_tokens', {
        value: 1998,
        configurable: true,
      });
      const fetchImpl = async () => makeJsonResponse(200, polluted);
      await callLunaAiJsonChat({
        env: baseEnv,
        system: 'sys',
        user: 'user',
        fetchImpl,
        call_label: 'source_proto_usage',
        nowMs: makeClock(1, 2),
        onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
      });
    } finally {
      deleteProtoKeys(['prompt_tokens', 'completion_tokens', 'total_tokens']);
    }
    const snap = snapshots[0] || {};
    ok(
      'prototype usage pollution does not fabricate snapshot token fields',
      !(
        snap.usage
        && Object.prototype.hasOwnProperty.call(snap.usage, 'prompt_tokens')
        && snap.usage.prompt_tokens === 999
      ),
    );
  }

  {
    let usageGets = 0;
    const snapshots = [];
    const response = deepClone(openaiMeasured);
    const usageValue = response.usage;
    delete response.usage;
    Object.defineProperty(response, 'usage', {
      get() {
        usageGets += 1;
        return usageValue;
      },
      enumerable: true,
      configurable: true,
    });
    const fetchImpl = async () => makeJsonResponse(200, response);
    const text = await callLunaAiJsonChat({
      env: baseEnv,
      system: 'sys',
      user: 'user',
      fetchImpl,
      call_label: 'source_accessor_usage',
      nowMs: makeClock(1, 2),
      onUsageObservation: (snap) => { snapshots.push(deepClone(snap)); },
    });
    ok('accessor usage still returns assistant text', typeof text === 'string' && text.length > 0);
    ok('accessor usage getter was not invoked by observer snapshot', usageGets === 0);
    ok(
      'accessor usage yields snapshot without usage own-data',
      Boolean(snapshots[0] && !Object.prototype.hasOwnProperty.call(snapshots[0], 'usage')),
    );
  }
} else {
  ok('source behavioral checks skipped (module missing)', false, 'provider or observer unavailable');
}

// Source hygiene
const observerSrc = fs.existsSync(OBSERVER_PATH) ? fs.readFileSync(OBSERVER_PATH, 'utf8') : '';
ok('observer requires local adapter module', /crowsnest-ai-usage-adapter/.test(observerSrc));
ok('observer does not require luna-ai-provider', !/luna-ai-provider/.test(observerSrc));
ok('observer does not require staff-query-api', !/staff-query-api/.test(observerSrc));
ok('observer does not require crowsnest-api', !/crowsnest-api/.test(observerSrc));
ok('observer does not open network sockets', !/\b(?:http|https|net|fetch|axios)\b/.test(observerSrc));
ok('observer does not write files', !/writeFile|appendFile|createWriteStream/.test(observerSrc));
ok('observer does not persist or open db', !/\b(?:persist|postgres|sqlite|mongodb|redis|createPool|createClient)\b/i.test(observerSrc));
ok('observer does not read process.env for tenant', !/process\.env/.test(observerSrc));
ok(
  'observer uses Object.getOwnPropertyDescriptor for own-data reads',
  /Object\.getOwnPropertyDescriptor/.test(observerSrc),
);

const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
ok('source doc records audit none_qualifies / none qualifies', /none_qualifies|none qualifies/i.test(doc));
ok('source doc mentions activation prerequisites', /activation prerequisite/i.test(doc));
ok('source doc documents non-goals', /non-goals/i.test(doc));
ok('source doc documents optional observer', /onUsageObservation|optional/i.test(doc));
ok('source doc documents no persistence', /no persistence|does not persist|not persist/i.test(doc));

const productDoc = fs.readFileSync(PRODUCT_DOC_PATH, 'utf8');
ok('CROWSNEST.md mentions AI usage source', /ai usage source|AI-USAGE-SOURCE/i.test(productDoc));
ok(
  'CROWSNEST.md lists verify:crowsnest-ai-usage-source',
  /verify:crowsnest-ai-usage-source/.test(productDoc),
);

console.log(`\n── verify:crowsnest-ai-usage-source: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:crowsnest-ai-usage-source — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
