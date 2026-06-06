/**
 * Phase 19e.5a — Verifier for guest reply send idempotency / audit.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-guest-reply-send-idempotency
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(ROOT, 'database', 'migrations', '013_guest_message_sends.sql');
const SQL_HELPER = path.join(__dirname, 'lib', 'luna-guest-message-send-sql.js');
const SEND_ROUTE = path.join(__dirname, 'lib', 'luna-guest-reply-send-route.js');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG = path.join(ROOT, 'package.json');

const GATES_ON_ENV = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
};

const AUTO_ON_DRY_ENV = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'true',
};

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

const {
  evaluateGuestReplySendRoute,
  evaluateGuestReplySendRouteWithPause,
} = require('./lib/luna-guest-reply-send-route');

console.log('\nverify-luna-agent-phase19-guest-reply-send-idempotency.js  (Phase 19e.5a)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

function readyBody(sendKind, idem) {
  return {
    client_slug: 'wolfhouse-somo',
    idempotency_key: idem || 'phase19e5a-idem-001',
    send_kind: sendKind,
    to: '+15555550180',
    suggested_reply: 'Which dates are you looking for?',
    source: 'guest_reply_draft',
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: true,
      allowed_send_kind: sendKind,
    },
  };
}

function createGuestMessageSendMockPg() {
  const rows = new Map();
  const keyOf = (slug, idem) => `${slug}\0${idem}`;
  let seq = 0;

  function dbRow(row) {
    return {
      id: row.id,
      client_slug: row.client_slug,
      channel: row.channel || 'whatsapp',
      to_phone: row.to_phone,
      idempotency_key: row.idempotency_key,
      send_kind: row.send_kind,
      source: row.source,
      message_text: row.message_text,
      status: row.status,
      blocked_reasons: row.blocked_reasons || [],
      provider_message_id: row.provider_message_id || null,
      provider_response: row.provider_response || null,
      created_at: row.created_at || new Date().toISOString(),
      sent_at: row.sent_at || null,
      updated_at: row.updated_at || new Date().toISOString(),
    };
  }

  return {
    rows,
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      if (norm.includes('from guest_message_sends where')) {
        const row = rows.get(keyOf(params[0], params[1]));
        return { rows: row ? [dbRow(row)] : [] };
      }

      if (norm.includes('insert into guest_message_sends') && norm.includes('on conflict')) {
        const k = keyOf(params[0], params[3]);
        if (rows.has(k)) return { rows: [] };
        const row = {
          id: `gms-${++seq}`,
          client_slug: params[0],
          channel: params[1],
          to_phone: params[2],
          idempotency_key: params[3],
          send_kind: params[4],
          source: params[5],
          message_text: params[6],
          status: norm.includes("'pending'") ? 'pending' : 'blocked',
          blocked_reasons: norm.includes("'pending'") ? [] : JSON.parse(params[7] || '[]'),
          provider_message_id: null,
          provider_response: null,
        };
        rows.set(k, row);
        return { rows: [dbRow(row)] };
      }

      if (norm.startsWith('update guest_message_sends') && norm.includes("status = 'sent'")) {
        const row = [...rows.values()].find((r) => r.id === params[0]);
        if (!row) return { rows: [] };
        row.status = 'sent';
        row.provider_message_id = params[1];
        row.blocked_reasons = [];
        row.sent_at = new Date().toISOString();
        row.updated_at = row.sent_at;
        return { rows: [dbRow(row)] };
      }

      if (norm.startsWith('update guest_message_sends') && norm.includes("status = 'blocked'")) {
        const row = [...rows.values()].find((r) => r.id === params[0]);
        if (!row) return { rows: [] };
        row.status = 'blocked';
        row.blocked_reasons = JSON.parse(params[1] || '[]');
        row.updated_at = new Date().toISOString();
        return { rows: [dbRow(row)] };
      }

      if (/bot_pause_states/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

section('A. Migration + helper');

const migSrc = readOrEmpty(MIGRATION);
const sqlSrc = readOrEmpty(SQL_HELPER);
const routeSrc = readOrEmpty(SEND_ROUTE);
const idempotencySrc = migSrc + sqlSrc + routeSrc;

if (fs.existsSync(MIGRATION)) pass('A1', '013_guest_message_sends migration exists');
else fail('A1', 'migration missing');

if (/CREATE TABLE IF NOT EXISTS guest_message_sends/i.test(migSrc)) {
  pass('A2', 'migration creates guest_message_sends');
} else fail('A2', 'guest_message_sends table missing in migration');

if (/UNIQUE\s*\(\s*client_slug\s*,\s*idempotency_key\s*\)/i.test(migSrc)) {
  pass('A3', 'unique(client_slug, idempotency_key) present');
} else fail('A3', 'unique constraint missing');

if (fs.existsSync(SQL_HELPER)) pass('A4', 'luna-guest-message-send-sql.js exists');
else fail('A4', 'sql helper missing');

if (routeSrc.includes('luna-guest-message-send-sql')) pass('A5', 'send route imports idempotency helper');
else fail('A5', 'send route idempotency import missing');

section('B. Mock pg idempotency behavior');

(async () => {
  const mockPg = createGuestMessageSendMockPg();
  let providerCalls = 0;
  const sendMessage = async () => {
    providerCalls += 1;
    return { success: true, whatsapp_message_id: 'mock-wamid-phase19e5a' };
  };

  const first = await evaluateGuestReplySendRouteWithPause(
    readyBody('ask_missing_field', 'phase19e5a-sent-once'),
    { pg: mockPg, env: GATES_ON_ENV, sendMessage },
  );
  const r1 = first.result;
  if (r1.success === true
    && r1.send_performed === true
    && r1.guest_message_send_status === 'sent'
    && r1.no_write_performed === false) {
    pass('B.sent', 'first mock provider success writes sent audit');
  } else {
    fail('B.sent', `first send audit failed: ${JSON.stringify(r1)}`);
  }

  const second = await evaluateGuestReplySendRouteWithPause(
    readyBody('ask_missing_field', 'phase19e5a-sent-once'),
    { pg: mockPg, env: GATES_ON_ENV, sendMessage },
  );
  const r2 = second.result;
  if (providerCalls === 1
    && r2.duplicate === true
    && r2.idempotent_replay === true
    && r2.send_performed === false
    && r2.sends_whatsapp === false
    && r2.guest_message_send_status === 'sent') {
    pass('B.replay', 'replay with same idempotency_key does not call provider');
  } else {
    fail('B.replay', `replay failed calls=${providerCalls} body=${JSON.stringify(r2)}`);
  }

  section('C. Provider blocked audit');

  const dryPg = createGuestMessageSendMockPg();
  const dry = await evaluateGuestReplySendRouteWithPause(
    readyBody('show_quote', 'phase19e5a-dry-block'),
    { pg: dryPg, env: AUTO_ON_DRY_ENV },
  );
  if (dry.result.blocked_reasons.includes('whatsapp_dry_run_active')
    && dry.result.guest_message_send_status === 'blocked'
    && dry.result.send_performed === false) {
    pass('C.dry', 'provider dry-run block writes blocked audit');
  } else {
    fail('C.dry', `dry-run audit failed: ${JSON.stringify(dry.result)}`);
  }

  const cfgPg = createGuestMessageSendMockPg();
  const cfg = await evaluateGuestReplySendRouteWithPause(
    readyBody('checkin_day', 'phase19e5a-config-missing'),
    { pg: cfgPg, env: GATES_ON_ENV },
  );
  if (cfg.result.blocked_reasons.includes('whatsapp_provider_config_missing')
    && cfg.result.guest_message_send_status === 'blocked'
    && cfg.result.send_performed === false) {
    pass('C.config', 'provider config-missing writes blocked audit');
  } else {
    fail('C.config', `config-missing audit failed: ${JSON.stringify(cfg.result)}`);
  }

  section('D. Risky / validation gates');

  const riskyPg = createGuestMessageSendMockPg();
  let riskyProviderCalls = 0;
  const risky = await evaluateGuestReplySendRouteWithPause({
    ...readyBody('show_quote', 'phase19e5a-risky'),
    send_eligibility: {
      send_allowed_later: false,
      requires_staff: true,
      auto_send_ready: true,
      allowed_send_kind: null,
    },
  }, {
    pg: riskyPg,
    env: GATES_ON_ENV,
    sendMessage: async () => { riskyProviderCalls += 1; return { success: true }; },
  });
  if (risky.result.blocked_reasons.includes('requires_staff')
    && riskyProviderCalls === 0
    && risky.result.guest_message_send_status === 'blocked'
    && !risky.result.blocked_reasons.includes('whatsapp_provider_config_missing')) {
    pass('D.risky', 'requires_staff blocks before provider and records blocked audit');
  } else {
    fail('D.risky', `risky case failed: ${JSON.stringify(risky.result)} calls=${riskyProviderCalls}`);
  }

  const noIdemPg = createGuestMessageSendMockPg();
  const noIdem = evaluateGuestReplySendRoute(
    { ...readyBody('ask_missing_field'), idempotency_key: '' },
    GATES_ON_ENV,
  );
  if (noIdem.status === 400
    && noIdem.result.error === 'idempotency_key_required'
    && noIdemPg.rows.size === 0) {
    pass('D.idem', 'missing idempotency blocks before DB insert');
  } else {
    fail('D.idem', 'missing idempotency validation failed');
  }

  section('E. Safety');

  if (/guest_message_sends/i.test(idempotencySrc)
    && !/INSERT INTO bookings|INSERT INTO payments|createStripe\s*\(/i.test(idempotencySrc)) {
    pass('E.sql.scope', 'SQL writes limited to guest_message_sends audit');
  } else fail('E.sql.scope', 'unexpected SQL writes');

  if (!/booking-create-from-plan|create-payment-link|api\.stripe\.com/i.test(idempotencySrc)) {
    pass('E.no_stripe_booking', 'no booking/payment/Stripe in idempotency path');
  } else fail('E.no_stripe_booking', 'booking/payment/Stripe detected');

  if (!/activateN8n|triggerN8n|fetchN8n\s*\(/i.test(idempotencySrc)) pass('E.no_n8n', 'no n8n activation');
  else fail('E.no_n8n', 'n8n detected');

  if (!/graph\.facebook\.com/i.test(routeSrc)) {
    pass('E.no_graph_in_route', 'no graph.facebook.com in send route');
  } else fail('E.no_graph_in_route', 'graph.facebook.com in send route');

  section('F. Downstream verifiers');

  for (const script of [
    'verify:luna-agent-phase19-guest-reply-send-route',
    'verify:luna-agent-phase19-whatsapp-provider',
  ]) {
    try {
      execSync(`npm run ${script}`, { stdio: 'pipe', cwd: ROOT, timeout: 120000 });
      pass('F.' + script, `${script} still passes`);
    } catch (e) {
      fail('F.' + script, `${script} failed`);
    }
  }

  section('G. npm script');
  const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-guest-reply-send-idempotency']) {
    pass('G1', 'npm script registered');
  } else {
    fail('G1', 'npm script missing');
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('VERIFIER_ERROR:', err.message);
  process.exit(1);
});
