#!/usr/bin/env node
'use strict';
// Offline regression: verbatim Staff handler + real handoff/cause SQL in PGlite.
// Auth/lease admission is an injected boundary; no live service or guest sends.
const assert = require('node:assert/strict');
const fs = require('node:fs');
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw Error('network_forbidden'); };
global.fetch = denyNetwork;
for (const name of ['node:net', 'node:tls', 'node:http', 'node:https']) {
  const mod = require(name);
  for (const key of ['connect', 'createConnection', 'request', 'get']) {
    if (typeof mod[key] === 'function') mod[key] = denyNetwork;
  }
}
require('node:net').Socket.prototype.connect = denyNetwork;
const { PGlite } = require('@electric-sql/pglite');
const { markConversationNeedsHuman } = require('./lib/luna-guest-handoff-persist');
const { recordSupervisorCauseOnConversation } = require('./lib/staff-supervisor-events');
const { getConversationStaffStateQuery } = require('./lib/staff-conversation-queries');
const ID = 'c04f5c84-e044-4aa8-8011-724462b0efb1';
const CLIENT = '10000000-0000-4000-8000-000000000002';
const CAUSE = '92ef2478-c938-4ceb-8d1c-341f0e8d86f8';
(async () => {
  const db = new PGlite();
  const sqlErrors = [];
  let sqlCalls = 0, admitted = true;
  const pg = { async query(sql, params) {
    sqlCalls++;
    try { const r = await db.query(sql, params); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; }
    catch (err) { sqlErrors.push(err.message); throw err; }
  } };
  const source = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
  const start = source.indexOf('async function handleConversationNeedsHuman(');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start);
  const respond = (res, status, body) => Object.assign(res, { status, body });
  const bindings = {
    readBody: async req => JSON.stringify(req.body), DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /[;]/, assertStaffClientAccess: () => true,
    admitSupervisorBodyWrite: async (_req, res, _user, payload, action) => {
      assert.equal(action, 'needs_human_set');
      assert.equal(payload.conversation_id, ID);
      assert.equal(payload.needs_human, true);
      if (!admitted) respond(res, 403, { success: false, error: 'supervisor_lease_required' });
      return { ok: admitted };
    },
    isSupervisorAccount: () => true,
    getSupervisorSendContext: () => ({ incident: { id: CAUSE } }),
    withPgClient: fn => fn(pg), markConversationNeedsHuman, recordSupervisorCauseOnConversation,
    sendJSON: respond, send400: (res, error) => respond(res, 400, { success: false, error }),
    send404: res => respond(res, 404, { success: false, error: 'Not found' }),
    sendSupervisorCompleted: respond, appendAuditLog: () => {},
  };
  const handler = new Function(...Object.keys(bindings), source.slice(start, end)
    + '; return handleConversationNeedsHuman;')(...Object.values(bindings));
  const call = async body => {
    const res = {};
    await handler(ID, { body }, res, { staff_user_id: 'offline-supervisor' });
    return res;
  };
  try {
    await db.exec(`
      CREATE TABLE clients(id uuid PRIMARY KEY, slug text UNIQUE, settings jsonb DEFAULT '{}');
      CREATE TABLE conversations(id uuid PRIMARY KEY, client_id uuid REFERENCES clients(id),
        phone text, language text, display_name text, needs_human boolean DEFAULT false,
        needs_human_transition_id uuid, metadata jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now(),
        bot_mode text DEFAULT 'bot', pending_action text, last_staff_reply_at timestamptz);
      CREATE TABLE messages(id uuid DEFAULT gen_random_uuid(), conversation_id uuid,
        direction text, message_text text, created_at timestamptz DEFAULT now());
      CREATE TABLE staff_handoffs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid,
        conversation_id uuid, phone text, source_channel text, reason_code text, summary text,
        status text, metadata jsonb DEFAULT '{}', priority text, assigned_staff text,
        opened_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), first_response_due_at timestamptz);
      CREATE TABLE bot_pause_states(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text,
        guest_phone text, conversation_id text, booking_id uuid, booking_code text, paused boolean,
        pause_reason text, paused_by text, paused_at timestamptz, resumed_by text, resumed_at timestamptz,
        metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      INSERT INTO clients(id,slug) VALUES ('${CLIENT}','wolfhouse-somo'),
        ('10000000-0000-4000-8000-000000000003','sunset');
      INSERT INTO conversations(id,client_id,phone,language,metadata) VALUES
        ('${ID}','${CLIENT}','+999123456789012','es',
         '{"simulator_synthetic":true,"source_owner":"crowsnest-guest-door"}');
    `);
    const state = () => db.query(getConversationStaffStateQuery(), ['wolfhouse-somo', ID]);
    assert.equal((await state()).rows.length, 1, 'real staff-state query finds simulator UUID');
    for (const invalid of [undefined, null, 'true', 1]) {
      const missing = await call({ conversation_id: ID, needs_human: invalid });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error, 'needs_human boolean is required');
    }
    assert.equal(sqlCalls, 0, 'missing/nonboolean values cannot read or write through handler');
    admitted = false;
    assert.equal((await call({ needs_human: true })).status, 403);
    assert.equal(sqlCalls, 0, 'lease refusal cannot reach conversation SQL');
    admitted = true;
    const out = await call({ client_slug: 'wolfhouse-somo', needs_human: true });
    assert.equal(out.status, 200, JSON.stringify(out));
    assert.equal(out.body.needs_human, true);
    assert.equal(out.body.conversation_paused, true);
    const after = (await state()).rows[0];
    assert.equal(after.needs_human, true);
    assert.ok(after.handoff_id, 'real handoff row exists');
    const saved = (await db.query('SELECT metadata FROM conversations WHERE id=$1::uuid', [ID])).rows[0];
    assert.equal(saved.metadata.supervisor_cause_incident_id, CAUSE);
    console.log('PASS explicit true flags exact simulator UUID, persists handoff/pause/cause; missing boolean and lease still fail');
    assert.equal((await call({ client_slug: 'sunset', needs_human: true })).status, 404);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM staff_handoffs')).rows[0].n, 1);
    // Public/guest UUID lookup remains denied, despite the authenticated Staff exception.
    assert.equal((await markConversationNeedsHuman(pg, { client_slug: 'wolfhouse-somo',
      conversation_id: ID, reason: 'human_requested' }, { skip_notify: true })).reason, 'conversation_not_found');
    await db.exec(`UPDATE conversations SET needs_human=false, metadata='{}' WHERE id='${ID}'`);
    assert.equal((await call({ needs_human: true, exact_simulator_phone: '+999123456789012',
      simulator_synthetic: true, source_owner: 'crowsnest-guest-door' })).status, 404);
    assert.equal((await state()).rows[0].needs_human, false, 'body cannot forge stored simulator markers');
    assert.deepEqual(sqlErrors, [], 'no swallowed SQL failures');
    assert.equal(networkAttempts, 0, 'synthetic handoff never attempts delivery');
    console.log('PASS wrong tenant, unmarked simulator and guest/bot UUID remain denied; no network');
  } finally { await db.close(); }
})().catch(err => { console.error(err.stack); process.exitCode = 1; });
