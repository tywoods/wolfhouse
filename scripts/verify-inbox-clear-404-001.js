#!/usr/bin/env node
'use strict';

/**
 * verify:inbox-clear-404-001
 *
 * INBOX-CLEAR-404-001 — Sunset Staff Inbox Clear must reset the Sunset
 * Hermes session via `/whatsapp/guest-session-key-reset`, never skip, and
 * never default-route Confirm to Wolfhouse `/wolfhouse/guest-session-key-reset`.
 *
 * Live evidence: Sunset Staff has no WOLFHOUSE_HERMES_BASE_URL or
 * WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL. Caddy `/whatsapp/*` reaches
 * hermes-sunset-luna:8092; `/wolfhouse/*` reaches Wolfhouse hermes-luna:8090.
 * Hermes registers a distinct authenticated Sunset alias (not webhook, no
 * hard_delete) so Confirm actually resets the Sunset session_key.
 *
 * Proves:
 *   - Sunset Staff (ingress/default slug sunset, no Hermes URL env) POSTs
 *     exactly once to `/whatsapp/guest-session-key-reset` and succeeds with
 *     attempted=true, reset=true — never skipped success
 *   - Conversation-only Clear still succeeds (needs_human cleared; no
 *     messages/bookings/payments wipe; no hard_delete)
 *   - Legacy overflow Reset still defaults to `/wolfhouse/guest-fresh-start`
 *   - Wolfhouse / unset tenant still defaults session-key reset to the
 *     Wolfhouse path; explicit URL still wins for Sunset
 *
 * Offline only. No production, send, delete, sethome, or live Hermes call.
 *
 * Run: node scripts/verify-inbox-clear-404-001.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HERMES_JS = path.join(ROOT, 'scripts/lib/luna-hermes-guest-session-reset.js');
const OWNER = path.join(ROOT, 'scripts/lib/staff-inbox-clear-thread.js');
const HERMES_PY = path.join(ROOT, 'docker/hermes-staging/wolfhouse_guest_fresh_start.py');
const PKG = path.join(ROOT, 'package.json');
const LUNA_ALL = path.join(ROOT, 'scripts/verify-luna-all.js');

const CONV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLIENT = 'sunset';
const WOLFHOUSE_SESSION_KEY_PATH = '/wolfhouse/guest-session-key-reset';
const SUNSET_SESSION_KEY_PATH = '/whatsapp/guest-session-key-reset';
const WOLFHOUSE_FRESH_START_PATH = '/wolfhouse/guest-fresh-start';
const WOLFHOUSE_DEFAULT_SESSION_KEY =
  'https://lunabox.lunafrontdesk.com/wolfhouse/guest-session-key-reset';
const SUNSET_DEFAULT_SESSION_KEY =
  'https://lunabox.lunafrontdesk.com/whatsapp/guest-session-key-reset';
const WOLFHOUSE_DEFAULT_FRESH_START =
  'https://lunabox.lunafrontdesk.com/wolfhouse/guest-fresh-start';

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

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const had = {};
  const prev = {};
  for (const k of keys) {
    had[k] = Object.prototype.hasOwnProperty.call(process.env, k);
    prev[k] = process.env[k];
    if (overrides[k] == null) delete process.env[k];
    else process.env[k] = String(overrides[k]);
  }
  const restore = () => {
    for (const k of keys) {
      if (had[k]) {
        if (prev[k] == null) delete process.env[k];
        else process.env[k] = prev[k];
      } else {
        delete process.env[k];
      }
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function sunsetStaffEnv(extra) {
  return Object.assign({
    STAFF_API_INGRESS_TENANT_SLUG: 'sunset',
    DEFAULT_CLIENT_SLUG: 'sunset',
    WOLFHOUSE_HERMES_BASE_URL: null,
    WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL: null,
    WOLFHOUSE_HERMES_GUEST_FRESH_START_URL: null,
    LUNA_BOT_INTERNAL_TOKEN: 'sunset-bot-token',
  }, extra || {});
}

function wolfhouseStaffEnv(extra) {
  return Object.assign({
    STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo',
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    WOLFHOUSE_HERMES_BASE_URL: null,
    WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL: null,
    WOLFHOUSE_HERMES_GUEST_FRESH_START_URL: null,
    LUNA_BOT_INTERNAL_TOKEN: 'wolfhouse-bot-token',
  }, extra || {});
}

function stubFetch(impl) {
  const calls = [];
  const prev = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return impl(url, opts, calls);
  };
  return {
    calls,
    restore() {
      if (prev == null) delete global.fetch;
      else global.fetch = prev;
    },
  };
}

function http404Response() {
  return {
    ok: false,
    status: 404,
    async json() {
      return {};
    },
  };
}

function sessionKeyResetOkResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, reset: true, scope: 'session_key', hard_delete: false };
    },
  };
}

function makeRecordingPg(seed) {
  const convs = (seed.conversations || []).map((r) => Object.assign({}, r));
  const messages = (seed.messages || []).map((r) => Object.assign({}, r));
  const bookings = (seed.bookings || []).map((r) => Object.assign({}, r));
  const payments = (seed.payments || []).map((r) => Object.assign({}, r));
  const calls = [];
  return {
    convs, messages, bookings, payments, calls,
    async query(sql, params) {
      const s = String(sql);
      const p = params ? [...params] : [];
      calls.push({ sql: s, params: p });
      if (/\bDELETE\b/i.test(s)) {
        throw new Error('forbidden_delete');
      }
      if (/SELECT[\s\S]*FROM conversations conv[\s\S]*JOIN clients/i.test(s)
        && /conv\.id = \$2::uuid/i.test(s)
        && !/regexp_replace/i.test(s)
        && !/\bUPDATE\b/i.test(s)) {
        const row = convs.find((c) => c.id === p[1] && c.client_slug === p[0]);
        return { rows: row ? [Object.assign({ conversation_id: row.id }, row)] : [] };
      }
      if (/regexp_replace/i.test(s) && /SELECT/i.test(s) && !/\bUPDATE\b/i.test(s)) {
        return {
          rows: convs.filter((c) => c.digits === p[0] && c.id !== p[1]).map((c) => ({
            conversation_id: c.id,
            client_slug: c.client_slug,
          })),
        };
      }
      if (/\bUPDATE conversations conv\b/i.test(s) && /needs_human = FALSE/i.test(s)) {
        const row = convs.find((c) => c.id === p[1] && c.client_slug === p[0]);
        if (!row) return { rows: [] };
        row.needs_human = false;
        return { rows: [{ conversation_id: row.id, needs_human: false }] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:inbox-clear-404-001 — Sunset Clear default routing\n');

  const hermesSrc = read(HERMES_JS);
  const hermesPy = read(HERMES_PY);
  const ownerSrc = read(OWNER);
  const pkg = JSON.parse(read(PKG) || '{}');
  const lunaAllSrc = read(LUNA_ALL);
  const hermes = require(HERMES_JS);
  const owner = require(OWNER);
  const convResetSrc = hermesSrc.slice(hermesSrc.indexOf('async function resetHermesConversationSession'));

  console.log('[1] Source: Sunset alias, tenant-safe default, legacy Reset untouched');
  ok('session-key URL helper exists', /function hermesSessionKeyResetUrl\(/.test(hermesSrc));
  ok('session-key URL consults Sunset Staff tenant (ingress or DEFAULT slug)',
    /STAFF_API_INGRESS_TENANT_SLUG/.test(hermesSrc)
    && /DEFAULT_CLIENT_SLUG/.test(hermesSrc)
    && /sunset/.test(hermesSrc));
  ok('Clear client still knows the Wolfhouse session-key path (Wolfhouse default only)',
    hermesSrc.includes(WOLFHOUSE_SESSION_KEY_PATH));
  ok('Clear client defaults Sunset to /whatsapp/guest-session-key-reset (not webhook)',
    hermesSrc.includes(SUNSET_SESSION_KEY_PATH)
    && !hermesSrc.includes('/whatsapp/webhook')
    && /staffTenantSlug\(env\) === 'sunset'/.test(hermesSrc));
  ok('Hermes registers authenticated Sunset session-key alias (not webhook, no hard_delete)',
    hermesPy.includes('SUNSET_SESSION_KEY_RESET_PATH = "/whatsapp/guest-session-key-reset"')
    && hermesPy.includes('app.router.add_post(SUNSET_SESSION_KEY_RESET_PATH')
    && !hermesPy.includes('/whatsapp/webhook'));
  ok('Clear client never skipped-success on missing Sunset URL',
    !/skipped:\s*true/.test(convResetSrc)
    && !/tenant_session_key_route_unconfigured/.test(hermesSrc)
    && !/return null;/.test(hermesSrc.slice(
      hermesSrc.indexOf('function hermesSessionKeyResetUrl'),
      hermesSrc.indexOf('async function resetHermesGuestSession'),
    )));
  ok('legacy Reset still uses guest-fresh-start / hermesFreshStartUrl',
    /function hermesFreshStartUrl\(/.test(hermesSrc)
    && hermesSrc.includes(WOLFHOUSE_FRESH_START_PATH)
    && /hermesFreshStartUrl\(/.test(hermesSrc.slice(hermesSrc.indexOf('async function resetHermesGuestSession'))));
  ok('Clear client never sends hard_delete true',
    !/hard_delete:\s*true/.test(convResetSrc));
  ok('owner still conversation-scoped (no staff-query-api rewrite)',
    /performInboxClearThreadReset/.test(ownerSrc)
    && /SQL_CLEAR_NEEDS_HUMAN/.test(ownerSrc)
    && !/hard_delete:\s*true/.test(ownerSrc));

  console.log('\n[2] Sunset Staff: default/explicit tenant POSTs the real Sunset alias');
  await withEnv(sunsetStaffEnv(), async () => {
    const url = hermes.hermesSessionKeyResetUrl();
    ok('Sunset with no Hermes URL env defaults to /whatsapp/guest-session-key-reset',
      url === SUNSET_DEFAULT_SESSION_KEY,
      String(url));
    ok('Sunset default is not the Wolfhouse session-key path',
      url !== WOLFHOUSE_DEFAULT_SESSION_KEY
      && !String(url).includes(WOLFHOUSE_SESSION_KEY_PATH),
      String(url));

    const fetchOk = stubFetch(async () => sessionKeyResetOkResponse());
    try {
      const out = await hermes.resetHermesConversationSession('+34600000001', {
        conversation_id: CONV_A,
      });
      ok('Sunset Clear POSTs the Sunset alias exactly once',
        fetchOk.calls.length === 1
        && fetchOk.calls[0].url === SUNSET_DEFAULT_SESSION_KEY
        && String(fetchOk.calls[0].opts.method || 'POST').toUpperCase() === 'POST',
        JSON.stringify(fetchOk.calls));
      ok('Sunset Clear does not POST /wolfhouse/guest-session-key-reset',
        fetchOk.calls.every((c) => !String(c.url).includes(WOLFHOUSE_SESSION_KEY_PATH)),
        JSON.stringify(fetchOk.calls));
      ok('Sunset Clear is attempted+reset success (never skipped)',
        out && out.ok === true
        && out.attempted === true
        && out.reset === true
        && out.skipped !== true
        && out.hard_delete !== true
        && out.reason !== 'http_404'
        && out.status !== 404,
        JSON.stringify(out));
      ok('Sunset Clear POST is authenticated session-key body (no hard_delete)',
        fetchOk.calls[0]
        && /"guest_phone":"\+34600000001"/.test(String(fetchOk.calls[0].opts.body || ''))
        && String(fetchOk.calls[0].opts.body || '').includes(CONV_A)
        && !/"hard_delete":true/.test(String(fetchOk.calls[0].opts.body || ''))
        && fetchOk.calls[0].opts.headers
        && fetchOk.calls[0].opts.headers['X-Luna-Bot-Token'] === 'sunset-bot-token',
        JSON.stringify(fetchOk.calls[0] && fetchOk.calls[0].opts));
    } finally {
      fetchOk.restore();
    }

    const fetch404 = stubFetch(async () => http404Response());
    try {
      const missed = await hermes.resetHermesConversationSession('+34600000001', {
        conversation_id: CONV_A,
      });
      ok('Sunset alias 404 surfaces as http_404 (never skipped success)',
        fetch404.calls.length === 1
        && fetch404.calls[0].url === SUNSET_DEFAULT_SESSION_KEY
        && missed && missed.ok === false
        && missed.attempted === true
        && missed.skipped !== true
        && missed.reason === 'http_404'
        && missed.status === 404,
        JSON.stringify({ missed, calls: fetch404.calls }));
    } finally {
      fetch404.restore();
    }

    const freshUrl = hermes.hermesFreshStartUrl();
    ok('legacy Reset URL on Sunset still defaults to guest-fresh-start',
      freshUrl === WOLFHOUSE_DEFAULT_FRESH_START
      || String(freshUrl).includes(WOLFHOUSE_FRESH_START_PATH),
      String(freshUrl));

    const resetFetch = stubFetch(async () => http404Response());
    try {
      const resetOut = await hermes.resetHermesGuestSession('+34600000001', { hard_delete: true });
      ok('legacy Reset still POSTs guest-fresh-start (not session-key)',
        resetFetch.calls.length === 1
        && String(resetFetch.calls[0].url).includes(WOLFHOUSE_FRESH_START_PATH)
        && !String(resetFetch.calls[0].url).includes(WOLFHOUSE_SESSION_KEY_PATH)
        && !String(resetFetch.calls[0].url).includes(SUNSET_SESSION_KEY_PATH),
        JSON.stringify(resetFetch.calls));
      ok('legacy Reset body still sends hard_delete',
        resetFetch.calls[0]
        && /"hard_delete":true/.test(String(resetFetch.calls[0].opts.body || '')),
        JSON.stringify(resetFetch.calls[0] && resetFetch.calls[0].opts));
      void resetOut;
    } finally {
      resetFetch.restore();
    }
  });

  await withEnv({
    STAFF_API_INGRESS_TENANT_SLUG: 'sunset',
    DEFAULT_CLIENT_SLUG: null,
    WOLFHOUSE_HERMES_BASE_URL: null,
    WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL: null,
  }, () => {
    ok('explicit ingress slug sunset uses the Sunset alias',
      hermes.hermesSessionKeyResetUrl() === SUNSET_DEFAULT_SESSION_KEY,
      String(hermes.hermesSessionKeyResetUrl()));
  });

  await withEnv({
    STAFF_API_INGRESS_TENANT_SLUG: null,
    DEFAULT_CLIENT_SLUG: 'sunset',
    WOLFHOUSE_HERMES_BASE_URL: null,
    WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL: null,
  }, () => {
    ok('default slug sunset uses the Sunset alias',
      hermes.hermesSessionKeyResetUrl() === SUNSET_DEFAULT_SESSION_KEY,
      String(hermes.hermesSessionKeyResetUrl()));
  });

  console.log('\n[3] Conversation-only Clear still succeeds after a real Sunset reset');
  await withEnv(sunsetStaffEnv(), async () => {
    const seed = {
      conversations: [
        {
          id: CONV_A, conversation_id: CONV_A, client_slug: CLIENT, phone: '+34600000001',
          digits: '34600000001', needs_human: true, display_name: 'Ana', status: 'open',
        },
        {
          id: CONV_B, conversation_id: CONV_B, client_slug: CLIENT, phone: '+34600000002',
          digits: '34600000002', needs_human: true, display_name: 'Bea', status: 'open',
        },
      ],
      messages: [
        { id: 'm1', conversation_id: CONV_A, message_text: 'hello' },
        { id: 'm2', conversation_id: CONV_B, message_text: 'other' },
      ],
      bookings: [
        { id: 'b1', conversation_id: CONV_A, code: 'SUN-1' },
        { id: 'b2', conversation_id: CONV_B, code: 'SUN-2' },
      ],
      payments: [{ id: 'p1', booking_id: 'b1', amount_cents: 5000 }],
    };
    const pg = makeRecordingPg(seed);
    const fetchOk = stubFetch(async () => sessionKeyResetOkResponse());
    try {
      const out = await owner.performInboxClearThreadReset({
        pg,
        clientSlug: CLIENT,
        convId: CONV_A,
        resetHermesConversationSession: hermes.resetHermesConversationSession,
      });
      ok('Sunset Confirm Clear is ok after real session-key reset',
        out && out.ok === true && out.found === true
        && out.reason !== 'http_404'
        && out.hermes_session_reset
        && out.hermes_session_reset.attempted === true
        && out.hermes_session_reset.reset === true
        && out.hermes_session_reset.ok === true
        && out.hermes_session_reset.skipped !== true
        && out.hermes_session_reset.reason !== 'http_404',
        JSON.stringify(out));
      ok('Sunset Confirm POSTs the Sunset alias exactly once',
        fetchOk.calls.length === 1
        && fetchOk.calls[0].url === SUNSET_DEFAULT_SESSION_KEY,
        JSON.stringify(fetchOk.calls));
      ok('needs_human cleared for the selected Sunset conversation only',
        out.needs_human_cleared === true
        && pg.convs.find((c) => c.id === CONV_A).needs_human === false
        && pg.convs.find((c) => c.id === CONV_B).needs_human === true);
      ok('messages/bookings/payments not mutated',
        pg.messages.length === 2 && pg.messages[0].message_text === 'hello'
        && pg.bookings.length === 2 && pg.bookings[0].code === 'SUN-1'
        && pg.payments[0].amount_cents === 5000);
      ok('no Wolfhouse session-key fetch on Sunset Confirm',
        fetchOk.calls.every((c) => !String(c.url).includes(WOLFHOUSE_SESSION_KEY_PATH)),
        JSON.stringify(fetchOk.calls));
    } finally {
      fetchOk.restore();
    }
  });

  console.log('\n[4] Explicit URL still wins; Wolfhouse default preserved');
  await withEnv(sunsetStaffEnv({
    WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL: 'https://sunset-hermes.test/session-key-reset',
  }), async () => {
    const url = hermes.hermesSessionKeyResetUrl();
    ok('Sunset explicit session-key URL is used as-is',
      url === 'https://sunset-hermes.test/session-key-reset',
      String(url));
    const fetchOk = stubFetch(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ok: true, reset: true, scope: 'session_key' };
      },
    }));
    try {
      const out = await hermes.resetHermesConversationSession('+34600000001', {
        conversation_id: CONV_A,
      });
      ok('Sunset explicit URL is POSTed (not Wolfhouse default)',
        fetchOk.calls.length === 1
        && fetchOk.calls[0].url === 'https://sunset-hermes.test/session-key-reset'
        && !String(fetchOk.calls[0].url).includes(WOLFHOUSE_SESSION_KEY_PATH),
        JSON.stringify(fetchOk.calls));
      ok('Sunset explicit URL success is attempted+reset (never skipped)',
        out && out.ok === true
        && out.reset === true
        && out.hard_delete === false
        && out.attempted === true
        && out.skipped !== true,
        JSON.stringify(out));
    } finally {
      fetchOk.restore();
    }
  });

  await withEnv(wolfhouseStaffEnv(), async () => {
    const url = hermes.hermesSessionKeyResetUrl();
    ok('Wolfhouse still defaults session-key reset to Lunabox /wolfhouse/guest-session-key-reset',
      url === WOLFHOUSE_DEFAULT_SESSION_KEY,
      String(url));
    const fetch404 = stubFetch(async () => http404Response());
    try {
      const out = await hermes.resetHermesConversationSession('+34600000001');
      ok('Wolfhouse default still POSTs the session-key path',
        fetch404.calls.length === 1
        && fetch404.calls[0].url === WOLFHOUSE_DEFAULT_SESSION_KEY,
        JSON.stringify(fetch404.calls));
      ok('Wolfhouse live 404 still surfaces as http_404 (unchanged default)',
        out && out.ok === false && out.reason === 'http_404' && out.status === 404,
        JSON.stringify(out));
    } finally {
      fetch404.restore();
    }
  });

  await withEnv({
    STAFF_API_INGRESS_TENANT_SLUG: null,
    DEFAULT_CLIENT_SLUG: null,
    WOLFHOUSE_HERMES_BASE_URL: null,
    WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL: null,
  }, () => {
    const url = hermes.hermesSessionKeyResetUrl();
    ok('unset tenant still defaults to Wolfhouse session-key path',
      url === WOLFHOUSE_DEFAULT_SESSION_KEY,
      String(url));
  });

  console.log('\n[5] Gate registration');
  ok('package.json registers verify:inbox-clear-404-001',
    pkg.scripts && pkg.scripts['verify:inbox-clear-404-001'] === 'node scripts/verify-inbox-clear-404-001.js');
  ok('luna-all registers this gate',
    /verify-inbox-clear-404-001\.js/.test(lunaAllSrc));

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:inbox-clear-404-001 — FAILED');
    process.exit(1);
  }
  console.log('verify:inbox-clear-404-001 — ALL CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('verify:inbox-clear-404-001 — ERROR', err);
  process.exit(1);
});
