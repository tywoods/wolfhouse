/**
 * Phase 19g.9 — Verifier for GET /staff/inbox/message-events read route.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-message-events-read
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const READ_HELPER = path.join(__dirname, 'lib', 'luna-guest-message-events-read.js');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase19-meta-inbound-persistence',
  'verify:luna-agent-phase19-meta-whatsapp-webhook',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase19-message-events-read.js  (Phase 19g.9)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const {
  DEFAULT_CLIENT_SLUG,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampMessageEventsLimit,
  parseMessageEventsQuery,
  buildMessageEventsListQuery,
  listGuestMessageEvents,
  formatInboxMessageEvent,
} = require('./lib/luna-guest-message-events-read');

const apiSrc = readOrEmpty(API);
const readSrc = readOrEmpty(READ_HELPER);
const handlerStart = apiSrc.indexOf('async function handleInboxMessageEvents(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('async function handleSurfForecast(', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

const routeIdx = apiSrc.indexOf("pathname === '/staff/inbox/message-events'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 500) : '';

section('A. Route + handler wiring');

if (apiSrc.includes("'/staff/inbox/message-events'")) pass('A1', 'route registered');
else fail('A1', 'route missing');

if (apiSrc.includes('handleInboxMessageEvents')) pass('A2', 'handler present');
else fail('A2', 'handler missing');

if (/requireAuth\(req, res, 'viewer'\)/.test(routeBlock)) {
  pass('A3', 'route uses requireAuth viewer session');
} else fail('A3', 'staff auth wiring missing');

if (!/requireBotAuth/.test(routeBlock + handler)) pass('A4', 'route/handler avoids bot auth');
else fail('A4', 'should not use bot auth');

if (apiSrc.includes('listGuestMessageEvents')) pass('A5', 'handler uses listGuestMessageEvents');
else fail('A5', 'list helper wiring missing');

if (apiSrc.includes('parseMessageEventsQuery')) pass('A6', 'handler parses query filters');
else fail('A6', 'query parser wiring missing');

section('B. Read helper — limit + query parsing');

if (clampMessageEventsLimit(undefined) === DEFAULT_LIMIT) pass('B1', 'default limit 50');
else fail('B1', 'default limit wrong');

if (clampMessageEventsLimit(999) === MAX_LIMIT) pass('B2', 'limit clamped to 200');
else fail('B2', 'limit clamp wrong');

const parsedDefault = parseMessageEventsQuery({});
if (parsedDefault.ok && parsedDefault.filters.client_slug === DEFAULT_CLIENT_SLUG) {
  pass('B3', 'default client_slug wolfhouse-somo');
} else fail('B3', 'default client_slug wrong');

const badBool = parseMessageEventsQuery({ handoff_required: 'maybe' });
if (!badBool.ok) pass('B4', 'invalid handoff_required rejected');
else fail('B4', 'invalid boolean should fail');

const badSince = parseMessageEventsQuery({ since: 'not-a-date' });
if (!badSince.ok) pass('B5', 'invalid since rejected');
else fail('B5', 'invalid since should fail');

section('C. SQL builder filters');

const qAll = buildMessageEventsListQuery({
  client_slug: 'wolfhouse-somo',
  limit: 50,
});
if (/client_slug = \$1/i.test(qAll.sql) && /order by created_at desc/i.test(qAll.sql)) {
  pass('C1', 'base query filters client_slug and sorts newest first');
} else fail('C1', 'base query wrong');

const qPhone = buildMessageEventsListQuery({
  client_slug: 'wolfhouse-somo',
  from_phone: '+491726422307',
  limit: 10,
});
if (/from_phone/i.test(qPhone.sql) && qPhone.params.includes('%491726422307%')) {
  pass('C2', 'from_phone filter present');
} else fail('C2', 'from_phone filter missing');

const qHandoff = buildMessageEventsListQuery({
  client_slug: 'wolfhouse-somo',
  handoff_required: true,
  limit: 10,
});
if (/handoff_required = \$/i.test(qHandoff.sql) && qHandoff.params.includes(true)) {
  pass('C3', 'handoff_required filter present');
} else fail('C3', 'handoff_required filter missing');

const qSend = buildMessageEventsListQuery({
  client_slug: 'wolfhouse-somo',
  send_attempted: true,
  limit: 10,
});
if (/send_attempted = \$/i.test(qSend.sql) && qSend.params.includes(true)) {
  pass('C4', 'send_attempted filter present');
} else fail('C4', 'send_attempted filter missing');

const qAction = buildMessageEventsListQuery({
  client_slug: 'wolfhouse-somo',
  next_action: 'handoff_to_staff',
  limit: 10,
});
if (/next_action = \$/i.test(qAction.sql) && qAction.params.includes('handoff_to_staff')) {
  pass('C5', 'next_action filter present');
} else fail('C5', 'next_action filter missing');

const qSince = buildMessageEventsListQuery({
  client_slug: 'wolfhouse-somo',
  since: '2026-06-06T00:00:00.000Z',
  limit: 10,
});
if (/created_at >= \$/i.test(qSince.sql)) pass('C6', 'since filter present');
else fail('C6', 'since filter missing');

if (!/\bINSERT\b/i.test(readSrc) && !/\bUPDATE\b/i.test(readSrc) && !/\bDELETE\b/i.test(readSrc)) {
  pass('C7', 'read helper is SELECT-only');
} else fail('C7', 'write SQL in read helper');

section('D. Mock pg list behavior');

function createEventsMockPg(rows) {
  return {
    rows,
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!norm.includes('from guest_message_events')) return { rows: [] };

      let filtered = rows.filter((r) => r.client_slug === params[0]);

      let idx = 1;
      if (params[idx] && String(params[idx]).includes('%')) {
        const needle = String(params[idx]).replace(/%/g, '');
        filtered = filtered.filter((r) => String(r.from_phone || '').replace(/^\+/, '').includes(needle.replace(/^\+/, '')));
        idx += 1;
      }
      if (typeof params[idx] === 'boolean' && norm.includes('handoff_required =')) {
        filtered = filtered.filter((r) => r.handoff_required === params[idx]);
        idx += 1;
      } else if (typeof params[idx] === 'boolean' && norm.includes('send_attempted =')) {
        filtered = filtered.filter((r) => r.send_attempted === params[idx]);
        idx += 1;
      }
      if (typeof params[idx] === 'string' && norm.includes('next_action =')) {
        filtered = filtered.filter((r) => r.next_action === params[idx]);
        idx += 1;
      }
      if (typeof params[idx] === 'string' && norm.includes('created_at >=')) {
        const since = new Date(params[idx]).getTime();
        filtered = filtered.filter((r) => new Date(r.created_at).getTime() >= since);
        idx += 1;
      }

      const limit = params[params.length - 1];
      filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: filtered.slice(0, limit) };
    },
  };
}

(async () => {
  const seed = [
    {
      id: 'evt-old',
      client_slug: 'wolfhouse-somo',
      from_phone: '491726422307',
      wa_message_id: 'wamid.old',
      message_type: 'text',
      message_text: 'old',
      profile_name: 'Guest',
      draft_called: true,
      next_action: 'ask_missing_field',
      suggested_reply: 'dates?',
      handoff_required: false,
      send_attempted: true,
      send_status: 'blocked',
      send_blocked_reasons: ['luna_auto_send_not_enabled'],
      created_at: '2026-06-06T10:00:00.000Z',
    },
    {
      id: 'evt-new',
      client_slug: 'wolfhouse-somo',
      from_phone: '491726422307',
      wa_message_id: 'wamid.new',
      message_type: 'text',
      message_text: 'refund please',
      profile_name: 'Guest',
      draft_called: true,
      next_action: 'handoff_to_staff',
      suggested_reply: 'team member',
      handoff_required: true,
      send_attempted: false,
      send_status: null,
      send_blocked_reasons: [],
      created_at: '2026-06-06T11:00:00.000Z',
    },
    {
      id: 'evt-other',
      client_slug: 'other-client',
      from_phone: '15555550101',
      wa_message_id: 'wamid.other',
      message_type: 'text',
      message_text: 'hello',
      profile_name: null,
      draft_called: false,
      next_action: null,
      suggested_reply: null,
      handoff_required: false,
      send_attempted: false,
      send_status: null,
      send_blocked_reasons: [],
      created_at: '2026-06-06T12:00:00.000Z',
    },
  ];

  const pg = createEventsMockPg(seed);
  const all = await listGuestMessageEvents(pg, { client_slug: 'wolfhouse-somo', limit: 50 });
  if (all.events.length === 2 && all.events[0].wa_message_id === 'wamid.new') {
    pass('D1', 'client_slug filter + newest first');
  } else fail('D1', 'list ordering/filter failed');

  const handoff = await listGuestMessageEvents(pg, {
    client_slug: 'wolfhouse-somo',
    handoff_required: true,
    limit: 50,
  });
  if (handoff.events.length === 1 && handoff.events[0].next_action === 'handoff_to_staff') {
    pass('D2', 'handoff_required filter works');
  } else fail('D2', 'handoff filter failed');

  const phone = await listGuestMessageEvents(pg, {
    client_slug: 'wolfhouse-somo',
    from_phone: '491726422307',
    limit: 50,
  });
  if (phone.events.length === 2) pass('D3', 'from_phone filter works');
  else fail('D3', 'from_phone filter failed');

  const send = await listGuestMessageEvents(pg, {
    client_slug: 'wolfhouse-somo',
    send_attempted: true,
    limit: 50,
  });
  if (send.events.length === 1 && send.events[0].send_attempted === true) {
    pass('D4', 'send_attempted filter works');
  } else fail('D4', 'send_attempted filter failed');

  const action = await listGuestMessageEvents(pg, {
    client_slug: 'wolfhouse-somo',
    next_action: 'ask_missing_field',
    limit: 50,
  });
  if (action.events.length === 1) pass('D5', 'next_action filter works');
  else fail('D5', 'next_action filter failed');

  const since = await listGuestMessageEvents(pg, {
    client_slug: 'wolfhouse-somo',
    since: '2026-06-06T10:30:00.000Z',
    limit: 50,
  });
  if (since.events.length === 1 && since.events[0].wa_message_id === 'wamid.new') {
    pass('D6', 'since filter works');
  } else fail('D6', 'since filter failed');

  const limited = await listGuestMessageEvents(pg, { client_slug: 'wolfhouse-somo', limit: 1 });
  if (limited.events.length === 1) pass('D7', 'limit respected');
  else fail('D7', 'limit failed');

  const formatted = formatInboxMessageEvent(seed[0]);
  if (formatted && !('raw_payload' in formatted) && !('normalized' in formatted)) {
    pass('D8', 'API event shape omits raw_payload/normalized');
  } else fail('D8', 'event shape wrong');

  const missingPg = {
    query: async () => {
      const err = new Error('relation "guest_message_events" does not exist');
      err.code = '42P01';
      throw err;
    },
  };
  const missing = await listGuestMessageEvents(missingPg, { client_slug: 'wolfhouse-somo', limit: 10 });
  if (missing.table_missing === true && missing.events.length === 0) {
    pass('D9', 'table_missing returns empty events');
  } else fail('D9', 'table_missing handling wrong');

  section('E. Safety — no send/write/external');

  const forbidden = [
    ['graph.facebook.com', /graph\.facebook\.com/i],
    ['api.stripe.com', /api\.stripe\.com/i],
    ['n8n activation', /\/api\/v1\/workflows\/|activateWorkflow/i],
    ['booking insert', /insert into bookings/i],
    ['payment insert', /insert into payments/i],
  ];
  for (const [label, re] of forbidden) {
    if (!re.test(handler + readSrc)) pass('E.' + label, 'avoids ' + label);
    else fail('E.' + label, label + ' found');
  }

  if (!/\bINSERT\b/i.test(handler) && !/\bUPDATE\b/i.test(handler) && !/\bDELETE\b/i.test(handler)) {
    pass('E.sql', 'handler has no SQL writes');
  } else fail('E.sql', 'handler SQL writes found');

  section('F. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-message-events-read']) {
    pass('F1', 'npm script registered');
  } else fail('F1', 'npm script missing');

  section('G. Downstream verifiers (limited)');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
      pass('G.' + script, `${script} still passes`);
    } catch (e) {
      fail('G.' + script, `${script} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      console.error(out.split('\n').slice(-8).join('\n'));
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Verifier crash:', e);
  process.exit(1);
});
