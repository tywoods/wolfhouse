'use strict';
/** Gate 3 outbound foundation offline verifier. PGlite = constraint/replay evidence (not multi-session concurrency). */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const ROOT = path.join(__dirname, '..');
const CONTRACT = require('./lib/email-microsoft-delegated-oauth-contract');
const {
  FAILURE_CODE, PREFER_IMMUTABLE_ID, HOST,
  EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202,
  buildCreateReplyPath, buildMessagePath, readTrustedGraphStage,
  createMicrosoftGraphReplyDraftTransport,
} = require('./lib/email-microsoft-graph-reply-draft-transport');
const UP_068 = fs.readFileSync(path.join(ROOT, 'database/migrations/068_tenant_email_outbound_send_journal.sql'), 'utf8');
const DOWN_068 = fs.readFileSync(path.join(ROOT, 'database/migrations/068_tenant_email_outbound_send_journal_down.sql'), 'utf8');
const TOKEN = 'atok-NEVER_LEAK-outbound-foundation-token-xyz';
const PLANTED = 'NEVER_LEAK_body_or_address';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const SOURCE_MSG = 'AAMkAGI2-SRC';
const DRAFT_ID = 'AAMkAGI2-DRAFT-IMMUTABLE';
let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function noLeak(v) {
  const t = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return !t.includes(TOKEN) && !t.includes(PLANTED) && !t.includes('access_token');
}
function scopeA(o) { return { phase: 'A', oidc: ['openid', 'profile', 'offline_access'], graph_delegated: ['User.Read', 'Mail.ReadBasic'], include_email_scope: false, ...o }; }
function scopeB(o) { return { phase: 'B', oidc: ['openid', 'profile', 'offline_access'], graph_delegated: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'], include_email_scope: false, ...o }; }
function mockHttps(handler) {
  return function request(options, onResponse) {
    if (handler.capture) handler.capture(options);
    const planned = handler.next ? handler.next(options) : handler;
    const response = new EventEmitter(); response.statusCode = planned.statusCode;
    Object.defineProperty(response, 'headers', {
      value: { 'content-type': planned.contentType === undefined ? 'application/json' : planned.contentType, ...(planned.headers || {}) },
      enumerable: true, configurable: true,
    });
    const req = new EventEmitter();
    req.end = () => {
      queueMicrotask(() => {
        onResponse(response);
        if (planned.body) response.emit('data', Buffer.from(planned.body, 'utf8')); response.emit('end');
      });
    }; req.destroy = () => {}; response.destroy = () => {}; response.on = response.on.bind(response); response.once = response.once.bind(response);
    return req;
  };
}
async function mustFail(action, stage) {
  await assert.rejects(action, (e) => e.code === FAILURE_CODE && readTrustedGraphStage(e) === stage && Object.isFrozen(e) && noLeak(e));
}
async function main() {
  console.log('verify:email-outbound-foundation — Gate 3 offline foundation\n');
  const a = CONTRACT.validateMicrosoftDelegatedScopePlan(scopeA());
  ok('phase_a byte-compat', a.ok && a.value.phase === 'A' && a.value.scope_version === 'phase_a_v2'
    && a.value.phase_b_included_in_phase_a === false && !a.value.graph_delegated.includes('Mail.Send')
    && CONTRACT.validateMicrosoftDelegatedScopePlan(scopeA({ graph_delegated: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'] })).ok === false);
  const b = CONTRACT.validateMicrosoftDelegatedScopePlan(scopeB());
  ok('phase_b_v1 exact scopes', b.ok && b.value.scope_version === 'phase_b_v1'
    && b.value.graph_delegated.join(' ') === 'User.Read Mail.ReadWrite Mail.Send'
    && CONTRACT.EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION === 'phase_b_v1');
  ok('phase_b rejects broader/unknown', [
    { graph_delegated: ['User.Read', 'Mail.ReadBasic'] }, { graph_delegated: ['User.Read', 'Mail.ReadWrite'] },
    { graph_delegated: ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Mail.Read'] },
    { graph_delegated: ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read'] },
    { graph_delegated: ['User.Read', 'Mail.ReadWrite.Shared', 'Mail.Send'] },
    { graph_delegated: ['User.Read', 'Mail.ReadWrite', 'Mail.Send', '/.default'] },
    { oidc: ['openid', 'profile'] }, { phase: 'C' },
  ].every((p) => CONTRACT.validateMicrosoftDelegatedScopePlan(scopeB(p)).ok === false));
  const tok = CONTRACT.validateMicrosoftDelegatedPhaseBTokenResponseScope('openid profile offline_access User.Read Mail.ReadWrite Mail.Send');
  const tokN = CONTRACT.validateMicrosoftDelegatedPhaseBTokenResponseScope('email User.Read Mail.Send Mail.ReadWrite openid');
  ok('phase_b token scope normalize + OIDC only', tok.ok && tok.value === 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send'
    && tokN.ok && tokN.value === 'openid email User.Read Mail.ReadWrite Mail.Send'
    && CONTRACT.validateMicrosoftDelegatedPhaseBTokenResponseScope('User.Read Mail.ReadWrite Mail.Send Mail.Read').ok === false
    && CONTRACT.validateMicrosoftDelegatedPhaseBTokenResponseScope('User.Read Mail.ReadBasic Mail.ReadWrite Mail.Send').ok === false
    && CONTRACT.validateMicrosoftDelegatedPhaseBTokenResponseScope('User.Read Mail.ReadWrite').ok === false);
  ok('068 journal static contract',
    /CREATE TABLE tenant_email_outbound_send_journal/.test(UP_068) && /location_key/.test(UP_068)
    && /tenant_locations_client_id_id_location_key_uq/.test(UP_068) && /tenant_channel_endpoints_client_id_id_location_key_uq/.test(UP_068)
    && /tenant_email_outbound_send_journal_location_identity_fk/.test(UP_068) && /tenant_email_outbound_send_journal_endpoint_location_fk/.test(UP_068)
    && /REFERENCES conversations \(client_id, id\)/.test(UP_068) && /REFERENCES staff_users \(client_id, id\)/.test(UP_068)
    && /operation_id\s+UUID PRIMARY KEY/.test(UP_068) && /approval_id/.test(UP_068) && /immutable_draft_id/.test(UP_068)
    && /body_digest/.test(UP_068) && /send_invocation_count >= 0 AND send_invocation_count <= 1/.test(UP_068)
    && /outcome_unknown/.test(UP_068) && /tenant_email_outbound_send_journal_approval_uq/.test(UP_068)
    && /tenant_email_outbound_send_journal_protect/.test(UP_068) && /immutable field mutation refused/.test(UP_068)
    && /illegal phase transition/.test(UP_068) && !/WHEN 'claimed' THEN 0 WHEN 'draft_created' THEN 1/.test(UP_068)
    && !/access_token|refresh_token|message_body|raw_payload|caller_address/i.test(UP_068)
    && !/INSERT INTO tenant_email_outbound_send_journal/.test(UP_068) && /068_down_refused/.test(DOWN_068));
  ok('transport pins', EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED === false && EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202 === false && PREFER_IMMUTABLE_ID === 'IdType="ImmutableId"' && HOST === 'graph.microsoft.com');
  const createPath = buildCreateReplyPath(MAILBOX, SOURCE_MSG);
  const sendPath = buildMessagePath(MAILBOX, DRAFT_ID, 'send');
  const getPath = buildMessagePath(MAILBOX, DRAFT_ID, 'get');
  const patchPath = buildMessagePath(MAILBOX, DRAFT_ID, 'patch');
  ok('fixed users paths', createPath.includes(`/users/${MAILBOX}/messages/`) && createPath.endsWith('/createReply') && !createPath.includes('/me/') && sendPath.endsWith('/send') && getPath.includes('$select=id,isDraft') && patchPath === `/v1.0/users/${MAILBOX}/messages/${encodeURIComponent(DRAFT_ID)}`);
  {
    let pathSafe = true;
    for (const h of [Symbol('x'), { toString() { pathSafe = false; return MAILBOX; } }, new Proxy({}, { get() { pathSafe = false; return MAILBOX; } })]) {
      if (buildCreateReplyPath(h, SOURCE_MSG) !== null || buildMessagePath(h, DRAFT_ID, 'send') !== null
          || buildCreateReplyPath(MAILBOX, h) !== null || buildMessagePath(MAILBOX, h, 'send') !== null) pathSafe = false;
    }
    const accessor = {}; Object.defineProperty(accessor, 'toString', { get() { pathSafe = false; return () => MAILBOX; } });
    try { if (buildCreateReplyPath(accessor, SOURCE_MSG) !== null) pathSafe = false; } catch { pathSafe = false; }
    ok('path builders reject Symbol/object/proxy/accessor without coercion', pathSafe);
  }
  {
    const c1 = []; const i1 = { accessToken: TOKEN, provider_mailbox_id: MAILBOX, source_message_id: SOURCE_MSG };
    const r1 = await createMicrosoftGraphReplyDraftTransport({ httpsImpl: mockHttps({ capture: (o) => c1.push(o), statusCode: 201, body: JSON.stringify({ id: DRAFT_ID, isDraft: true, subject: PLANTED }) }) }).createReply(i1);
    ok('createReply Prefer+host+scrub', c1.length === 1 && c1[0].hostname === HOST && c1[0].method === 'POST' && c1[0].path === createPath
      && c1[0].headers.Prefer === PREFER_IMMUTABLE_ID && r1.outcome === 'draft_created' && r1.immutable_draft_id === DRAFT_ID && i1.accessToken === null && noLeak(r1));
    const c2 = []; const i2 = { accessToken: TOKEN, provider_mailbox_id: MAILBOX, immutable_draft_id: DRAFT_ID, body_content_type: 'Text', body_content: `Approved ${PLANTED}` };
    const r2 = await createMicrosoftGraphReplyDraftTransport({ httpsImpl: mockHttps({ capture: (o) => c2.push(o), statusCode: 200, body: JSON.stringify({ id: DRAFT_ID }) }) }).updateApprovedDraft(i2);
    ok('update exact draft', c2[0].method === 'PATCH' && c2[0].path === patchPath && c2[0].headers.Prefer === PREFER_IMMUTABLE_ID && r2.outcome === 'draft_updated' && i2.accessToken === null);
    const c3 = []; const i3 = { accessToken: TOKEN, provider_mailbox_id: MAILBOX, immutable_draft_id: DRAFT_ID };
    const t3 = createMicrosoftGraphReplyDraftTransport({ httpsImpl: mockHttps({ capture: (o) => c3.push(o), statusCode: 202, body: '', contentType: '' }) });
    const r3 = await t3.sendDraft(i3);
    let second = false; try { await t3.sendDraft({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, immutable_draft_id: DRAFT_ID }); } catch (e) { second = e.code === FAILURE_CODE; }
    ok('send once; no delivery from 202', c3.length === 1 && c3[0].path === sendPath && r3.outcome === 'send_accepted' && r3.delivery_claimed === false && r3.requires_reconcile === true && second && i3.accessToken === null);
  }
  {
    const sent = await createMicrosoftGraphReplyDraftTransport({ httpsImpl: mockHttps({ statusCode: 200, body: JSON.stringify({ id: DRAFT_ID, isDraft: false }) }) })
      .reconcileDraft({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, immutable_draft_id: DRAFT_ID });
    const unk = await createMicrosoftGraphReplyDraftTransport({ httpsImpl: mockHttps({ statusCode: 200, body: JSON.stringify({ id: DRAFT_ID, isDraft: true }) }) })
      .reconcileDraft({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, immutable_draft_id: DRAFT_ID });
    await mustFail(() => createMicrosoftGraphReplyDraftTransport({ httpsImpl: mockHttps({ statusCode: 404, body: '{}' }) })
      .reconcileDraft({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, immutable_draft_id: DRAFT_ID }), 'outcome_unknown');
    ok('reconcile sent / outcome_unknown / 404', sent.outcome === 'sent' && sent.isDraft === false && sent.authorize_automatic_resend === false
      && unk.outcome === 'outcome_unknown' && unk.authorize_automatic_resend === false && unk.authorize_automatic_create_reply === false);
    let step = 0;
    const t = createMicrosoftGraphReplyDraftTransport({
      httpsImpl: mockHttps({ next() { step += 1; return step === 1 ? { statusCode: 202, body: '', contentType: '' } : { statusCode: 200, body: JSON.stringify({ id: DRAFT_ID, isDraft: true }) }; } }),
    });
    const accepted = await t.sendDraft({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, immutable_draft_id: DRAFT_ID });
    const recon = await t.reconcileDraft({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, immutable_draft_id: DRAFT_ID });
    ok('forced uncertainty after 202', accepted.delivery_claimed === false && recon.outcome === 'outcome_unknown' && recon.authorize_automatic_resend === false);
    await mustFail(() => createMicrosoftGraphReplyDraftTransport({ httpsImpl: mockHttps({ statusCode: 500, body: '{"error":"x"}' }) })
      .createReply({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, source_message_id: SOURCE_MSG }), 'http_status_not_success');
    let rejected = false;
    try { createMicrosoftGraphReplyDraftTransport({ evil: true }); } catch (e) { rejected = e.code === FAILURE_CODE && noLeak(e); }
    ok('fail-closed HTTP 500 + unknown deps', rejected);
  }
  {
    let requestCalls = 0;
    const t = createMicrosoftGraphReplyDraftTransport({
      httpsImpl: () => { requestCalls += 1; throw new Error('unexpected'); },
      timers: { setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {} },
    });
    await mustFail(() => t.createReply({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, source_message_id: SOURCE_MSG }), 'deadline_exceeded');
    ok('sync deadline settles; zero Graph request', requestCalls === 0);
  }
  {
    let scrubOk = true; let getterHits = 0;
    const t = createMicrosoftGraphReplyDraftTransport({ httpsImpl: mockHttps({ statusCode: 201, body: '{}' }) });
    for (const input of [
      { accessToken: TOKEN, provider_mailbox_id: MAILBOX },
      { accessToken: TOKEN, provider_mailbox_id: 'not-a-uuid', source_message_id: SOURCE_MSG },
      { accessToken: TOKEN, provider_mailbox_id: MAILBOX, source_message_id: SOURCE_MSG, extra: 1 },
    ]) { await mustFail(() => t.createReply(input), 'request_error'); if (input.accessToken !== null) scrubOk = false; }
    const accessorInput = {};
    Object.defineProperty(accessorInput, 'accessToken', { get() { getterHits += 1; return TOKEN; }, enumerable: true });
    Object.defineProperty(accessorInput, 'provider_mailbox_id', { value: MAILBOX, enumerable: true });
    Object.defineProperty(accessorInput, 'source_message_id', { value: SOURCE_MSG, enumerable: true });
    await mustFail(() => t.createReply(accessorInput), 'request_error');
    if (getterHits !== 0) scrubOk = false;
    await mustFail(() => t.createReply(new Proxy(
      { accessToken: TOKEN, provider_mailbox_id: MAILBOX, source_message_id: SOURCE_MSG },
      { get(target, prop, recv) { return Reflect.get(target, prop, recv); } },
    )), 'request_error');
    ok('scrub accessToken on reject; hostile fail sanitized', scrubOk);
  }
  {
    let depReject = false; let accessorTimersReject = false; let lifecycleHits = 0;
    try { createMicrosoftGraphReplyDraftTransport({ timers: new Proxy({ setTimeout() {}, clearTimeout() {} }, { get(t, p, r) { return Reflect.get(t, p, r); } }) }); }
    catch (e) { depReject = e.code === FAILURE_CODE; }
    const badTimers = {};
    Object.defineProperty(badTimers, 'setTimeout', { get() { return () => 1; }, enumerable: true });
    Object.defineProperty(badTimers, 'clearTimeout', { value: () => {}, enumerable: true });
    try { createMicrosoftGraphReplyDraftTransport({ timers: badTimers }); } catch (e) { accessorTimersReject = e.code === FAILURE_CODE; }
    const hostileReq = new EventEmitter();
    Object.defineProperty(hostileReq, 'end', { get() { lifecycleHits += 1; return () => {}; }, enumerable: true });
    Object.defineProperty(hostileReq, 'once', { get() { lifecycleHits += 1; return EventEmitter.prototype.once; }, enumerable: true });
    hostileReq.destroy = () => {};
    await mustFail(() => createMicrosoftGraphReplyDraftTransport({ httpsImpl: () => hostileReq })
      .createReply({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, source_message_id: SOURCE_MSG }), 'request_error');
    await mustFail(() => createMicrosoftGraphReplyDraftTransport({
      httpsImpl: () => { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => {}; req.once = req.once.bind(req); return req; },
      timers: { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout: () => {} },
    }).createReply({ accessToken: TOKEN, provider_mailbox_id: MAILBOX, source_message_id: SOURCE_MSG }), 'deadline_exceeded');
    ok('capability-contain timers/lifecycle + async deadline', depReject && accessorTimersReject && lifecycleHits === 0);
  }
  await proveJournalPglite();
  console.log(`\n── verify:email-outbound-foundation ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
/** PGlite mandatory (NODE_PATH=/opt/data/wolfhouse-agent/node_modules). Constraint/replay only — not multi-session concurrency. */
async function proveJournalPglite() {
  let PGlite = null;
  for (const base of [process.env.NODE_PATH, '/opt/data/wolfhouse-agent/node_modules', path.join(ROOT, 'node_modules')].filter(Boolean)) {
    try { PGlite = require(path.join(String(base).split(path.delimiter)[0], '@electric-sql/pglite')).PGlite; if (PGlite) break; } catch { /* next */ }
  }
  if (!PGlite) { try { PGlite = require('@electric-sql/pglite').PGlite; } catch { /* */ } }
  if (!PGlite) { ok('068 pglite mandatory (constraint/replay evidence)', false, 'PGlite unavailable — NODE_PATH=/opt/data/wolfhouse-agent/node_modules'); return; }
  const C = '11111111-1111-4111-8111-111111111111'; const CB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const L = '22222222-2222-4222-8222-222222222222'; const LB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const E = '33333333-3333-4333-8333-333333333333'; const EB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const V = '44444444-4444-4444-8444-444444444444'; const VB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const A = '55555555-5555-4555-8555-555555555555'; const K = 'sunset-somo'; const KB = 'sunset-other';
  const digest = crypto.createHash('sha256').update('approved-body', 'utf8').digest('hex');
  const draft = 'AAMkAGI2-OUTBOUND-DRAFT-001';
  const db = new PGlite();
  await db.exec(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE staff_users (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id));
    ALTER TABLE staff_users ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
    CREATE TABLE tenant_locations (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), location_id text NOT NULL, display_name text NOT NULL DEFAULT 'loc', active boolean NOT NULL DEFAULT true);
    ALTER TABLE tenant_locations ADD CONSTRAINT tenant_locations_client_id_id_uq UNIQUE (client_id, id);
    ALTER TABLE tenant_locations ADD CONSTRAINT tenant_locations_client_location_uq UNIQUE (client_id, location_id);
    CREATE TABLE tenant_channel_endpoints (id uuid PRIMARY KEY, client_id uuid NOT NULL, location_id text NOT NULL, channel text NOT NULL DEFAULT 'email', provider text NOT NULL DEFAULT 'microsoft_graph', public_address text NOT NULL DEFAULT 'a@b.co', secret_ref text, capabilities jsonb NOT NULL DEFAULT '{}'::jsonb);
    ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_client_id_id_uq UNIQUE (client_id, id);
    CREATE TABLE conversations (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), phone text);
    ALTER TABLE conversations ADD CONSTRAINT conversations_client_id_id_uq UNIQUE (client_id, id);
    INSERT INTO clients VALUES ('${C}'), ('${CB}');
    INSERT INTO staff_users (id, client_id) VALUES ('${A}', '${C}');
    INSERT INTO tenant_locations (id, client_id, location_id) VALUES ('${L}', '${C}', '${K}'), ('${LB}', '${C}', '${KB}');
    INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES ('${E}', '${C}', '${K}'), ('${EB}', '${C}', '${KB}');
    INSERT INTO conversations (id, client_id, phone) VALUES ('${V}', '${C}', 'emailv1:x'), ('${VB}', '${CB}', 'emailv1:y');
  `);
  await db.exec(UP_068);
  const T = 'tenant_email_outbound_send_journal';
  const insert = (op, ap, x = {}) => db.query(
    `INSERT INTO ${T} (operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, approval_id, actor_staff_user_id, provider, immutable_draft_id, body_digest, phase, outcome, send_invocation_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'microsoft_graph',NULL,$9,'claimed','claimed',0)`,
    [op, x.clientId || C, x.locationId || L, x.locationKey || K, x.endpointId || E, x.conversationId || V, ap, A, x.digest || digest],
  );
  const refuse = async (sql, p) => { try { await db.query(sql, p); return false; } catch { return true; } };
  const up = (op, set, p = []) => db.query(`UPDATE ${T} SET ${set} WHERE operation_id=$1`, [op, ...p]);
  // Happy path + same-state idempotence: claimed→draft_created→draft_updated→send_dispatched→reconciled_sent.
  const op1 = crypto.randomUUID(); await insert(op1, crypto.randomUUID());
  let idemp = true;
  for (const [set, p] of [
    [`phase='draft_created', outcome='not_committed', immutable_draft_id=$2`, [draft]],
    [`phase='draft_updated', outcome='not_committed'`, []],
    [`phase='send_dispatched', outcome='outcome_unknown', send_invocation_count=1`, []],
    [`phase='reconciled_sent', outcome='committed'`, []],
  ]) { try { await up(op1, set, p); await up(op1, set, p); } catch { idemp = false; } }
  const done = await db.query(`SELECT phase, outcome, send_invocation_count FROM ${T} WHERE operation_id=$1`, [op1]);
  ok('068 pglite happy path (constraint/replay)', done.rows[0].phase === 'reconciled_sent' && done.rows[0].outcome === 'committed' && Number(done.rows[0].send_invocation_count) === 1);
  ok('068 same-state phase idempotence', idemp);
  // Illegal skips incl. claimed→reconciled_sent (fabricate completed send).
  async function skipFrom(from, set) {
    const op = crypto.randomUUID(); await insert(op, crypto.randomUUID());
    if (from !== 'claimed') {
      await up(op, `phase='draft_created', outcome='not_committed', immutable_draft_id=$2`, [`${draft}-S-${crypto.randomUUID()}`]);
      if (from !== 'draft_created') await up(op, `phase='draft_updated', outcome='not_committed'`);
    }
    return refuse(`UPDATE ${T} SET ${set} WHERE operation_id=$1`, [op]);
  }
  const skips = [];
  for (const [from, set] of [
    ['claimed', `phase='reconciled_sent', outcome='committed', immutable_draft_id='AAMk-SKIP1', send_invocation_count=1`],
    ['claimed', `phase='draft_updated', outcome='not_committed', immutable_draft_id='AAMk-SKIP2'`],
    ['claimed', `phase='send_dispatched', outcome='outcome_unknown', immutable_draft_id='AAMk-SKIP3', send_invocation_count=1`],
    ['draft_created', `phase='send_dispatched', outcome='outcome_unknown', send_invocation_count=1`],
    ['draft_created', `phase='reconciled_sent', outcome='committed', send_invocation_count=1`],
    ['draft_updated', `phase='reconciled_sent', outcome='committed', send_invocation_count=1`],
  ]) skips.push(await skipFrom(from, set));
  ok('068 phase skips rejected (claimed→reconciled_sent + all other skips)', skips.every(Boolean));
  // Terminal same-state + cannot reopen (pre-send terminal outcome/count via CHECK).
  const opT = crypto.randomUUID(); await insert(opT, crypto.randomUUID());
  await up(opT, `phase='terminal', outcome='not_committed'`);
  try { await up(opT, `phase='terminal', outcome='not_committed'`); } catch { idemp = false; }
  ok('068 terminal same-state + cannot reopen', idemp
    && await refuse(`UPDATE ${T} SET phase='claimed', outcome='claimed' WHERE operation_id=$1`, [opT])
    && await refuse(`UPDATE ${T} SET phase='draft_created', outcome='not_committed', immutable_draft_id=$2 WHERE operation_id=$1`, [opT, `${draft}-T`])
    && await refuse(`UPDATE ${T} SET phase='reconciled_sent', outcome='committed', immutable_draft_id=$2, send_invocation_count=1 WHERE operation_id=$1`, [opT, `${draft}-T2`]));
  ok('068 pglite send cap', await refuse(`UPDATE ${T} SET send_invocation_count=2 WHERE operation_id=$1`, [op1]));
  const dupOp = crypto.randomUUID(); const apDup = crypto.randomUUID(); await insert(dupOp, apDup);
  let dupOpR = false; let dupApR = false; let crossLoc = false; let cross = false;
  try { await insert(dupOp, crypto.randomUUID()); } catch { dupOpR = true; }
  try { await insert(crypto.randomUUID(), apDup); } catch { dupApR = true; }
  try { await insert(crypto.randomUUID(), crypto.randomUUID(), { locationId: L, locationKey: K, endpointId: EB }); } catch { crossLoc = true; }
  try { await insert(crypto.randomUUID(), crypto.randomUUID(), { conversationId: VB }); } catch { cross = true; }
  ok('068 duplicate operation_id/approval_id rejected (constraint evidence, not concurrent sessions)', dupOpR && dupApR);
  ok('068 same-tenant location-A/endpoint-B rejected', crossLoc);
  ok('068 tenant conversation FK', cross);
  const opG = crypto.randomUUID(); await insert(opG, crypto.randomUUID());
  await up(opG, `phase='draft_created', outcome='not_committed', immutable_draft_id=$2`, [`${draft}-G`]);
  await up(opG, `phase='draft_updated', outcome='not_committed'`);
  const draftReplace = await refuse(`UPDATE ${T} SET immutable_draft_id=$2 WHERE operation_id=$1`, [opG, `${draft}-G2`]);
  const identityMut = await refuse(`UPDATE ${T} SET approval_id=$2 WHERE operation_id=$1`, [opG, crypto.randomUUID()]);
  await up(opG, `phase='send_dispatched', outcome='outcome_unknown', send_invocation_count=1`);
  ok('068 update guard: draft replace / identity / decrement / dispatched→draft_updated',
    draftReplace && identityMut
    && await refuse(`UPDATE ${T} SET send_invocation_count=0 WHERE operation_id=$1`, [opG])
    && await refuse(`UPDATE ${T} SET phase='draft_updated', outcome='not_committed', send_invocation_count=0 WHERE operation_id=$1`, [opG]));
  let downRefused = false;
  try { await db.exec(DOWN_068); } catch (e) { downRefused = /068_down_refused/.test(String(e && e.message || e)); }
  try { await db.query('ROLLBACK'); } catch { /* */ }
  ok('068 down fail-closed with rows', downRefused);
}
