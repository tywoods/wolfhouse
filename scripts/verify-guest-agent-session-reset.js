'use strict';

/**
 * Static gate — Hermes guest session hard-delete + portal reset wiring.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const freshStart = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/wolfhouse_guest_fresh_start.py'), 'utf8');
const patches = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/apply_gateway_patches.py'), 'utf8');
// The Inbox front-end is injected into /staff/ui from scripts/browser/inbox-*.js, so the
// portal-side assertions below read the template plus those modules.
const staffApi = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const resetLib = fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-hermes-guest-session-reset.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }

console.log('\nverify-guest-agent-session-reset.js\n');

check('A1', /delete_guest_agent_sessions/.test(freshStart), 'hard-delete helper exists');
check('A2', /delete_session\(/.test(freshStart), 'calls SessionDB.delete_session');
check('A3', /_entries\.pop\(session_key/.test(freshStart), 'drops routing entry (not rotate-only)');
check('A4', /hard_delete/.test(freshStart), 'fresh-start API accepts hard_delete');
check('A5', /clear_luna_agent_memories/.test(freshStart), 'hard-delete clears agent memories');
check('A6', /memories_cleared/.test(freshStart), 'reset returns memories_cleared');

check('B1', /session_stale_routing_skip/.test(patches), 'session stale routing patch wired');
check('B2', /luna_soul_reload/.test(patches), 'Luna SOUL reload patch wired');
check('B3', /_evict_cached_agent\(session_key\)/.test(patches), 'evicts agent cache each Luna turn');

check('C1', /reset-agent-session/.test(staffApi), 'portal reset-agent-session route');
check('C2', /btn-agent-session-reset/.test(staffApi), 'Reset Luna session button');
check('C3', /handleConversationResetAgentSession/.test(staffApi), 'agent-only reset handler');
check('C4', /hard_delete:\s*true/.test(staffApi), 'full wipe uses hard_delete');
check('C5', /clear-thread-session/.test(staffApi), 'Inbox Clear uses distinct clear-thread-session route');
check('C6', /handleConversationClearThreadSession/.test(staffApi), 'Inbox Clear has its own handler');
check('C7', /guest-session-key-reset/.test(resetLib), 'Clear Hermes client uses distinct session-key route');
check('C8', /guest-fresh-start/.test(resetLib), 'overflow/full-wipe Hermes client keeps guest-fresh-start');

check('D1', /hard_delete/.test(resetLib), 'Staff API client sends hard_delete');
check('D2', !/\|\|\s*'https:\/\/lunabox\.lunafrontdesk\.com'/.test(resetLib), 'unset Hermes base is not the old Lunabox default');

const reset = require('./lib/luna-hermes-guest-session-reset');

function unreachableError(name, code) {
  const err = new Error(name === 'TimeoutError' ? 'The operation was aborted due to timeout' : 'fetch failed');
  err.name = name;
  if (code) {
    err.code = code;
    err.cause = { code };
  }
  return err;
}

async function expectUnreachable(label, thrown) {
  const env = {
    STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo',
    WOLFHOUSE_HERMES_BASE_URL: 'http://hermes-luna:8090',
    LUNA_BOT_INTERNAL_TOKEN: 'test-token',
  };
  const prev = global.fetch;
  let signal = null;
  global.fetch = async (_url, opts) => {
    signal = opts && opts.signal;
    throw thrown;
  };
  try {
    const out = await reset.resetHermesConversationSession('+34600000001', { env });
    check(label, out && out.reason === 'luna_unreachable' && out.attempted === true && signal && typeof signal.aborted === 'boolean', JSON.stringify(out));
  } finally {
    if (prev == null) delete global.fetch;
    else global.fetch = prev;
  }
}

function bodyStallResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw unreachableError('TimeoutError');
    },
  };
}

async function expectBodyStall(label, invoke) {
  const env = {
    STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo',
    WOLFHOUSE_HERMES_BASE_URL: 'http://hermes-luna:8090',
    LUNA_BOT_INTERNAL_TOKEN: 'test-token',
  };
  const prev = global.fetch;
  let signal = null;
  global.fetch = async (_url, opts) => {
    signal = opts && opts.signal;
    return bodyStallResponse();
  };
  try {
    const out = await invoke(env);
    check(
      label,
      out && out.reason === 'luna_unreachable' && out.ok === false && out.attempted === true && out.status == null
        && signal && typeof signal.aborted === 'boolean',
      JSON.stringify(out),
    );
  } finally {
    if (prev == null) delete global.fetch;
    else global.fetch = prev;
  }
}

async function expectMalformedStaysHttp(label, response, predicate) {
  const env = {
    STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo',
    WOLFHOUSE_HERMES_BASE_URL: 'http://hermes-luna:8090',
    LUNA_BOT_INTERNAL_TOKEN: 'test-token',
  };
  const prev = global.fetch;
  global.fetch = async () => response;
  try {
    const out = await reset.resetHermesConversationSession('+34600000001', { env });
    check(label, predicate(out), JSON.stringify(out));
  } finally {
    if (prev == null) delete global.fetch;
    else global.fetch = prev;
  }
}

(async () => {
  const unset = await reset.resetHermesConversationSession('+34600000001', {
    env: {
      STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo',
      LUNA_BOT_INTERNAL_TOKEN: 'test-token',
    },
  });
  check('E1', unset && unset.attempted === false && unset.reason === 'missing_session_key_url', JSON.stringify(unset));
  const sunset = reset.hermesSessionKeyResetUrl({
    STAFF_API_INGRESS_TENANT_SLUG: 'sunset',
  });
  check('E2', sunset === 'https://lunabox.lunafrontdesk.com/whatsapp/guest-session-key-reset', String(sunset));
  await expectUnreachable('E3', unreachableError('TimeoutError'));
  await expectUnreachable('E4', unreachableError('AbortError'));
  await expectUnreachable('E5', unreachableError('Error', 'UND_ERR_CONNECT_TIMEOUT'));
  await expectUnreachable('E6', unreachableError('Error', 'ECONNREFUSED'));
  await expectUnreachable('E7', unreachableError('Error', 'ENOTFOUND'));
  await expectBodyStall('E8', (env) => reset.resetHermesConversationSession('+34600000001', { env }));
  const savedEnv = {
    LUNA_BOT_INTERNAL_TOKEN: process.env.LUNA_BOT_INTERNAL_TOKEN,
    WOLFHOUSE_HERMES_BASE_URL: process.env.WOLFHOUSE_HERMES_BASE_URL,
    STAFF_API_INGRESS_TENANT_SLUG: process.env.STAFF_API_INGRESS_TENANT_SLUG,
    WOLFHOUSE_HERMES_GUEST_FRESH_START_URL: process.env.WOLFHOUSE_HERMES_GUEST_FRESH_START_URL,
  };
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'test-token';
  process.env.WOLFHOUSE_HERMES_BASE_URL = 'http://hermes-luna:8090';
  process.env.STAFF_API_INGRESS_TENANT_SLUG = 'wolfhouse-somo';
  delete process.env.WOLFHOUSE_HERMES_GUEST_FRESH_START_URL;
  try {
    await expectBodyStall('E9', () => reset.resetHermesGuestSession('+34600000001'));
  } finally {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] == null) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
  await expectMalformedStaysHttp('E10', {
    ok: false,
    status: 502,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  }, (out) => out && out.reason === 'http_502' && out.status === 502 && out.reason !== 'luna_unreachable');
  await expectMalformedStaysHttp('E11', {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  }, (out) => out && out.ok === false && out.status === 200 && out.reason !== 'luna_unreachable');
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
