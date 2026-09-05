#!/usr/bin/env node
'use strict';

/**
 * verify:luna-personality-staff-api
 *
 * Slice 2 of LUNA-PERSONALITY-001 — authenticated tenant-wide Staff setting
 * for WhatsApp-only Luna Personality. Offline (fake pg). No UI, no send.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts/lib/staff-luna-personality-routes.js');
const API_PATH = path.join(ROOT, 'scripts/staff-query-api.js');
const BROWSER_DIR = path.join(ROOT, 'scripts/browser');

const {
  PRODUCT_NAME,
  SETTINGS_KEY,
  DEFAULT_PERSONALITY_ID,
  CLOSED_PERSONALITY_IDS,
} = require('./lib/luna-guest-personality-packs');

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

function mockRes() {
  const out = { statusCode: 200, headers: {}, body: null, ended: false };
  return {
    out,
    writeHead(code, headers) {
      out.statusCode = code;
      if (headers) Object.assign(out.headers, headers);
    },
    setHeader(k, v) { out.headers[k] = v; },
    end(buf) {
      out.ended = true;
      out.body = buf == null ? '' : String(buf);
    },
  };
}

function mockReq(bodyObj) {
  const ee = new EventEmitter();
  const payload = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  process.nextTick(() => {
    if (payload) ee.emit('data', Buffer.from(payload, 'utf8'));
    ee.emit('end');
  });
  return ee;
}

function parseBody(out) {
  if (!out.body) return null;
  try { return JSON.parse(out.body); } catch (_) { return out.body; }
}

function makeStore() {
  return {
    'client-a': {
      id: 'client-a',
      slug: 'sunset',
      settings: { inbox_channel_modes: { whatsapp: 'auto' }, house_notes: 'keep-me' },
    },
    'client-b': {
      id: 'client-b',
      slug: 'wolfhouse-somo',
      settings: { inbox_channel_modes: { whatsapp: 'draft' }, luna_personality: 'calm' },
    },
  };
}

function makeDeps(store) {
  const queries = [];
  const deps = {
    sendJSON(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return body;
    },
    send400(res, message) {
      return deps.sendJSON(res, 400, { success: false, error: message });
    },
    readBody(req) {
      if (req._cachedBody !== undefined) return Promise.resolve(req._cachedBody);
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          req._cachedBody = Buffer.concat(chunks).toString('utf8');
          resolve(req._cachedBody);
        });
        req.on('error', reject);
      });
    },
    queries,
    async withPgClient(fn) {
      const pg = {
        async query(sql, params = []) {
          queries.push({ sql: String(sql), params });
          const q = String(sql);
          if (/SELECT settings FROM clients WHERE id/i.test(q)) {
            const row = store[params[0]];
            return { rows: row ? [{ settings: row.settings }] : [] };
          }
          if (/jsonb_set/i.test(q) && /UPDATE clients/i.test(q)) {
            const row = store[params[0]];
            if (!row) return { rows: [], rowCount: 0 };
            const nextId = params[1];
            row.settings = { ...row.settings, luna_personality: nextId };
            return { rows: [{ settings: row.settings }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return fn(pg);
    },
  };
  return deps;
}

console.log('\nverify:luna-personality-staff-api — tenant-wide WhatsApp personality setting\n');

console.log('[1] Module surface');
ok('routes module exists', fs.existsSync(MODULE_PATH), MODULE_PATH);

let createLunaPersonalityRoutes;
let LUNA_PERSONALITY_PATH;
let LUNA_PERSONALITY_BOT_PATH;
let LUNA_PERSONALITY_MIN_ROLE;
try {
  ({
    createLunaPersonalityRoutes,
    LUNA_PERSONALITY_PATH,
    LUNA_PERSONALITY_BOT_PATH,
    LUNA_PERSONALITY_MIN_ROLE,
  } = require('./lib/staff-luna-personality-routes'));
  ok('routes module loads', true);
} catch (err) {
  ok('routes module loads', false, err && err.message);
  console.log(`\nverify:luna-personality-staff-api: ${pass} passed, ${fail} failed`);
  process.exit(1);
}

ok('staff path is /staff/luna-personality', LUNA_PERSONALITY_PATH === '/staff/luna-personality');
ok('bot path is /staff/bot/luna-personality', LUNA_PERSONALITY_BOT_PATH === '/staff/bot/luna-personality');
ok('min role is operator', LUNA_PERSONALITY_MIN_ROLE === 'operator');
ok('createLunaPersonalityRoutes exported', typeof createLunaPersonalityRoutes === 'function');

const store = makeStore();
const deps = makeDeps(store);
const routes = createLunaPersonalityRoutes(deps);

ok('GET/PUT staff handlers', typeof routes.handlers.GET === 'function' && typeof routes.handlers.PUT === 'function');
ok('GET bot handler', typeof routes.handlers.BOT_GET === 'function');

async function staffGet(user, query) {
  const res = mockRes();
  await routes.handlers.GET(query || {}, mockReq(), res, user);
  return { status: res.out.statusCode, body: parseBody(res.out) };
}

async function staffPut(user, body, query) {
  const res = mockRes();
  await routes.handlers.PUT(query || {}, mockReq(body), res, user);
  return { status: res.out.statusCode, body: parseBody(res.out) };
}

async function botGet(user) {
  const res = mockRes();
  await routes.handlers.BOT_GET({}, mockReq(), res, user);
  return { status: res.out.statusCode, body: parseBody(res.out) };
}

const userA = { staff_user_id: 'u-a', client_id: 'client-a', client_slug: 'sunset', role: 'operator' };
const userB = { staff_user_id: 'u-b', client_id: 'client-b', client_slug: 'wolfhouse-somo', role: 'operator' };
const viewerA = { staff_user_id: 'u-v', client_id: 'client-a', client_slug: 'sunset', role: 'viewer' };

(async () => {
  console.log('\n[2] Auth tenant authority (not caller-controlled)');
  const missing = await staffGet(null, { client_slug: 'wolfhouse-somo' });
  ok('GET without user is 401', missing.status === 401);

  const defaultRead = await staffGet(userA, { client_slug: 'wolfhouse-somo' });
  ok('GET uses auth client_id, ignores query.client_slug',
    defaultRead.status === 200
    && defaultRead.body.personality_id === DEFAULT_PERSONALITY_ID
    && defaultRead.body.product === PRODUCT_NAME
    && defaultRead.body.channel === 'whatsapp'
    && defaultRead.body.source === 'default');

  const storedRead = await staffGet(userB, { client_slug: 'sunset' });
  ok('GET other-tenant query cannot read client-b as sunset',
    storedRead.status === 200
    && storedRead.body.personality_id === 'calm'
    && storedRead.body.source === 'stored');

  console.log('\n[3] Writes: closed ID only, siblings preserved');
  const badId = await staffPut(userA, { personality_id: 'cami' });
  ok('unknown ID rejected on write', badId.status === 400 && /invalid_personality_id|closed/i.test(JSON.stringify(badId.body)));
  ok('unknown write did not persist', store['client-a'].settings.luna_personality == null);

  const promptWrite = await staffPut(userA, { personality_id: 'extra', prompt: 'be sassy' });
  ok('caller style prompt rejected', promptWrite.status === 400 && /style|prompt|rejected/i.test(JSON.stringify(promptWrite.body)));

  const emailWrite = await staffPut(userA, { personality_id: 'extra', channel: 'email' });
  ok('email channel rejected (whatsapp-only v1)', emailWrite.status === 400);

  const okWrite = await staffPut(userA, { personality_id: 'extra' });
  ok('valid extra persists', okWrite.status === 200 && okWrite.body.personality_id === 'extra' && okWrite.body.persisted === true);
  ok('jsonb_set used for luna_personality', deps.queries.some((q) => /jsonb_set/i.test(q.sql) && q.sql.includes(`{${SETTINGS_KEY}}`)));
  ok('sibling inbox_channel_modes preserved', store['client-a'].settings.inbox_channel_modes.whatsapp === 'auto');
  ok('sibling house_notes preserved', store['client-a'].settings.house_notes === 'keep-me');

  const isolated = await staffGet(userB);
  ok('tenant isolation: client-b still calm', isolated.body.personality_id === 'calm');

  const afterA = await staffGet(userA);
  ok('next GET sees extra', afterA.body.personality_id === 'extra' && afterA.body.source === 'stored');

  store['client-a'].settings.luna_personality = 'not-a-real-id';
  const invalidRead = await staffGet(userA);
  ok('unknown stored ID resolves to sunny on read',
    invalidRead.status === 200
    && invalidRead.body.personality_id === 'sunny'
    && invalidRead.body.source === 'invalid_fallback');

  console.log('\n[4] Bot read (Luna runtime) uses principal tenant');
  const bot = await botGet({ client_id: 'client-b', client_slug: 'wolfhouse-somo', auth_mode: 'bot_token' });
  ok('bot GET returns stored calm', bot.status === 200 && bot.body.personality_id === 'calm' && bot.body.channel === 'whatsapp');
  const botNoUser = await botGet(null);
  ok('bot GET without principal is 401', botNoUser.status === 401);

  console.log('\n[5] staff-query-api wiring + no UI');
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');
  ok('API imports createLunaPersonalityRoutes', /createLunaPersonalityRoutes/.test(apiSrc));
  ok('API requireAuth operator on GET',
    /pathname === LUNA_PERSONALITY_PATH && method === 'GET'[\s\S]{0,280}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/.test(apiSrc));
  ok('API requireAuth operator on PUT',
    /pathname === LUNA_PERSONALITY_PATH && method === 'PUT'[\s\S]{0,280}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/.test(apiSrc));
  ok('API requireBotAuth on bot GET',
    /pathname === LUNA_PERSONALITY_BOT_PATH[\s\S]{0,280}?requireBotAuth\(/.test(apiSrc));
  ok('API does not take tenant from body/query for this setting',
    /handleLunaPersonality(Get|Put)/.test(apiSrc));

  const browserFiles = fs.existsSync(BROWSER_DIR)
    ? fs.readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.js'))
    : [];
  const uiHits = browserFiles.filter((f) => {
    const src = fs.readFileSync(path.join(BROWSER_DIR, f), 'utf8');
    return /luna-personality|Luna Personality/.test(src);
  });
  ok('no Staff radio UI/browser module in this slice', uiHits.length === 0, uiHits.join(', '));
  ok('closed ids listed in GET payload', Array.isArray(afterA.body.closed_ids)
    && CLOSED_PERSONALITY_IDS.every((id) => afterA.body.closed_ids.includes(id)));

  console.log(`\nverify:luna-personality-staff-api: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
