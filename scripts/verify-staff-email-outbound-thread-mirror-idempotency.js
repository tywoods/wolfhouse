'use strict';
/**
 * Behavioral idempotency for post-Graph-commit outbound thread mirrors.
 *
 * Exercises the real createStaffEmailInboxRoutes approve-send owner (not a
 * reimplemented helper). Proves concurrent/retried committed invocations for
 * one approval yield one durable messages row and one preview update; different
 * approvals remain independently insertable; foreign tenant/conversation scope
 * cannot collide; mirror DB failure never undoes provider-committed success.
 *
 * Also applies migration 072 (partial unique index) under PGlite and proves
 * INSERT ... ON CONFLICT DO NOTHING at the SQL boundary.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const UP_PATH = path.join(ROOT, 'database/migrations/072_messages_staff_email_reply_approval_uq.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/072_messages_staff_email_reply_approval_uq_down.sql');
const {
  createStaffEmailInboxRoutes,
  ENV_DRAFTS_ENABLED, ENV_OUTBOUND_ENABLED, ENV_SEND_ENABLED, ENV_COMPOSITION_ENABLED, ENV_PORTAL_ORIGIN,
  snapshotGateEnv, SQL_RESOLVE, SQL_APPROVE, SQL_JOURNAL_EXISTS,
} = require('./lib/staff-email-inbox-routes');

const C = '11111111-1111-4111-8111-111111111111';
const C2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const V2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = '55555555-5555-4555-8555-555555555555';
const EV = '66666666-6666-4666-8666-666666666666';
const K = 'sunset-somo';
const MAIL = 'desk@sunset.test';
const SRC = 'AAMkAGI2-SRC-EMAIL-MIRROR-IDEM';
const BODY = 'Outbound mirror idempotency body for Gate3 committed path.';
const ORIGIN = 'https://staff.sunset.test';
const DIGEST = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');

function enabledEnv(extra = {}) {
  return Object.freeze(Object.assign(Object.create(null), {
    [ENV_DRAFTS_ENABLED]: 'true',
    [ENV_OUTBOUND_ENABLED]: 'true',
    [ENV_SEND_ENABLED]: 'true',
    [ENV_COMPOSITION_ENABLED]: 'true',
    [ENV_PORTAL_ORIGIN]: ORIGIN,
  }, extra));
}
function user(o = {}) {
  return { staff_user_id: A, client_id: C, client_slug: 'sunset', role: 'operator', status: 'active', ...o };
}
function captureSend() {
  const calls = [];
  return {
    calls,
    sendJSON(_r, status, body) {
      calls.push({ status, body: body && typeof body === 'object' ? { ...body } : body });
      return body;
    },
  };
}
function mockReq(bodyObj, headers = {}) {
  const ee = new EventEmitter();
  const payload = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  Object.defineProperty(ee, 'headers', {
    value: Object.assign(Object.create(null), {
      'content-type': 'application/json', origin: ORIGIN,
    }, headers),
    enumerable: true, writable: true,
  });
  ee.destroy = function destroy(err) { ee.emit('error', err || new Error('destroyed')); };
  process.nextTick(() => {
    if (payload) ee.emit('data', Buffer.from(payload, 'utf8'));
    ee.emit('end');
  });
  return ee;
}
function dto(o = {}) {
  return { conversation_id: V, message_text: BODY, approval_id: null, ...o };
}
function authRow(o = {}) {
  return {
    conversation_id: V, client_id: C, location_id: L, location_key: K, endpoint_id: E,
    source_inbound_event_id: EV, provider: 'microsoft_graph', provider_mailbox_id: MAIL,
    provider_source_message_id: SRC, endpoint_outbound_enabled: true, public_address: MAIL,
    actor_staff_user_id: A, ...o,
  };
}

/**
 * Fake PG that models the durable approval journal + messages unique identity.
 * Mirror inserts use the same ON CONFLICT semantics as migration 072.
 */
function createMirrorPg(opts = {}) {
  const durable = new Map();
  const journal = new Set();
  /** @type {Map<string, {id:string, client_id:string, conversation_id:string, approval_id:string, message_text:string, source:string, route:string, direction:string}>} */
  const messages = new Map();
  const previews = new Map(); // conversation_id -> {preview, touches}
  let insertCalls = 0;
  let previewTouches = 0;
  let mirrorFail = opts.mirrorFail === true;
  let raceYield = opts.raceYield === true;
  const pendingClaims = new Set();

  function mirrorKey(clientId, conversationId, approvalId) {
    return `${String(clientId).toLowerCase()}|${String(conversationId).toLowerCase()}|${String(approvalId).toLowerCase()}`;
  }

  function parseMeta(raw) {
    if (raw && typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
  }

  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };

      if (/FROM clients cl/.test(n) || n === SQL_RESOLVE) {
        if (String(params[0]).toLowerCase() !== C
            || String(params[1]).toLowerCase() !== A
            || String(params[2]).toLowerCase() !== V) return { rows: [] };
        return { rows: [{ ...authRow() }] };
      }

      if (/^INSERT INTO tenant_email_reply_approvals/.test(n)) {
        const approvalId = String(params[0]).toLowerCase();
        const operationId = String(params[1]).toLowerCase();
        for (const r of durable.values()) {
          if (r.operation_id === operationId) {
            const e = new Error('dup'); e.code = '23505'; throw e;
          }
        }
        const row = {
          approval_id: approvalId, operation_id: operationId,
          client_id: String(params[2]).toLowerCase(),
          location_id: String(params[3]).toLowerCase(),
          location_key: String(params[4]),
          endpoint_id: String(params[5]).toLowerCase(),
          conversation_id: String(params[6]).toLowerCase(),
          source_inbound_event_id: String(params[7]).toLowerCase(),
          provider: 'microsoft_graph',
          provider_mailbox_id: String(params[8]),
          provider_source_message_id: String(params[9]),
          draft_actor_staff_user_id: String(params[10]).toLowerCase(),
          approved_actor_staff_user_id: null,
          message_text: String(params[11]), body_digest: String(params[12]), state: 'draft',
        };
        durable.set(approvalId, row);
        return { rows: [{ approval_id: row.approval_id, message_text: row.message_text, conversation_id: row.conversation_id }] };
      }

      if (/FOR UPDATE/.test(n)) {
        const id = String(params[0]).toLowerCase();
        const row = durable.get(id);
        if (!row || row.client_id !== String(params[1]).toLowerCase()
            || row.conversation_id !== String(params[2]).toLowerCase()) return { rows: [] };
        return { rows: [{ ...row }] };
      }

      if (n === SQL_JOURNAL_EXISTS) {
        return { rows: journal.has(String(params[2]).toLowerCase()) ? [{ journal_exists: 1 }] : [] };
      }

      if (/state='approved'/.test(n) || /state = 'approved'/.test(n)) {
        const row = durable.get(String(params[0]).toLowerCase());
        if (!row || row.client_id !== String(params[1]).toLowerCase()
            || row.conversation_id !== String(params[2]).toLowerCase()
            || row.state !== 'draft') return { rows: [] };
        if (row.operation_id !== String(params[3]).toLowerCase()) return { rows: [] };
        if (row.message_text !== String(params[5]) || row.body_digest !== String(params[6])) return { rows: [] };
        row.state = 'approved';
        row.approved_actor_staff_user_id = String(params[4]).toLowerCase();
        return { rows: [{ approval_id: row.approval_id, operation_id: row.operation_id, state: row.state }] };
      }

      // Atomic outbound mirror insert (ON CONFLICT DO NOTHING semantics).
      if (/^INSERT INTO messages/.test(n) && /staff_email_reply/.test(n)) {
        insertCalls += 1;
        if (mirrorFail) throw new Error('mirror_db_failure_planted');
        assert.match(n, /ON CONFLICT/, 'mirror insert must be ON CONFLICT idempotent');
        assert.match(n, /DO NOTHING/, 'mirror insert must DO NOTHING on conflict');
        const clientId = String(params[0]).toLowerCase();
        const conversationId = String(params[1]).toLowerCase();
        const messageText = String(params[2]);
        const meta = parseMeta(params[3]);
        const approvalId = String(meta.approval_id || '').toLowerCase();
        assert.ok(approvalId, 'mirror metadata.approval_id required');
        const key = mirrorKey(clientId, conversationId, approvalId);

        // Optional race window: two concurrent claims must still converge to one row.
        if (raceYield) {
          if (pendingClaims.has(key) || messages.has(key)) {
            await new Promise((r) => setImmediate(r));
            return { rows: [], rowCount: 0 };
          }
          pendingClaims.add(key);
          await new Promise((r) => setImmediate(r));
        }

        if (messages.has(key)) {
          pendingClaims.delete(key);
          return { rows: [], rowCount: 0 };
        }
        const id = crypto.randomUUID();
        messages.set(key, {
          id, client_id: clientId, conversation_id: conversationId,
          approval_id: approvalId, message_text: messageText,
          source: 'staff_email_reply', route: 'email', direction: 'outbound',
        });
        pendingClaims.delete(key);
        return { rows: [{ message_id: id }], rowCount: 1 };
      }

      if (/^UPDATE conversations/.test(n) && /last_message_preview/.test(n)) {
        previewTouches += 1;
        const clientId = String(params[0]).toLowerCase();
        const conversationId = String(params[1]).toLowerCase();
        const preview = String(params[2]);
        const prev = previews.get(conversationId) || { preview: null, touches: 0, client_id: clientId };
        prev.preview = preview;
        prev.touches += 1;
        prev.client_id = clientId;
        previews.set(conversationId, prev);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [] };
    },
  };

  return {
    durable, journal, messages, previews,
    get insertCalls() { return insertCalls; },
    get previewTouches() { return previewTouches; },
    setMirrorFail(v) { mirrorFail = v === true; },
    setRaceYield(v) { raceYield = v === true; },
    withPgClient: async (fn) => fn(client),
    seedApproved(approvalId, o = {}) {
      const id = String(approvalId).toLowerCase();
      const operationId = String(o.operation_id || crypto.randomUUID()).toLowerCase();
      durable.set(id, {
        approval_id: id, operation_id: operationId,
        client_id: String(o.client_id || C).toLowerCase(),
        location_id: L, location_key: K, endpoint_id: E,
        conversation_id: String(o.conversation_id || V).toLowerCase(),
        source_inbound_event_id: EV, provider: 'microsoft_graph',
        provider_mailbox_id: MAIL, provider_source_message_id: SRC,
        draft_actor_staff_user_id: A, approved_actor_staff_user_id: A,
        message_text: o.message_text || BODY, body_digest: o.body_digest || DIGEST,
        state: 'approved',
      });
      return operationId;
    },
    mirrorRowsFor(approvalId) {
      const a = String(approvalId).toLowerCase();
      return [...messages.values()].filter((m) => m.approval_id === a);
    },
  };
}

function tryLoadPglite() {
  try { return require('@electric-sql/pglite').PGlite; } catch { /* */ }
  try {
    const Module = require('node:module');
    const candidates = [
      '/opt/data/wolfhouse-agent/node_modules',
      path.join(ROOT, 'node_modules'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, '@electric-sql/pglite'))) {
        const prev = process.env.NODE_PATH || '';
        process.env.NODE_PATH = c + (prev ? path.delimiter + prev : '');
        Module._initPaths();
        return require('@electric-sql/pglite').PGlite;
      }
    }
  } catch { /* */ }
  return null;
}

async function proveApproveSendOwnerIdempotency() {
  console.log('  -- approve-send owner behavioral --');
  const gate = snapshotGateEnv(enabledEnv());
  const pg = createMirrorPg({ raceYield: true });
  const send = captureSend();
  let dispatches = 0;
  const routes = createStaffEmailInboxRoutes({
    sendJSON: send.sendJSON,
    withPgClient: pg.withPgClient,
    runtimeEnv: enabledEnv(),
    outboundDispatch: async (sealed) => {
      dispatches += 1;
      // Leave journal empty so concurrent committed retries both reach mirror.
      assert.equal(sealed.client_id, C);
      return Object.freeze({ ok: true, code: 'email_send_committed' });
    },
  });

  // Draft → approve-send concurrent pair for same approval after pre-approve.
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  assert.equal(send.calls[0].status, 200);
  const ap = send.calls[0].body.approval_id;
  // Force approved + no journal so both concurrent calls dispatch+mirror.
  const op = pg.durable.get(ap).operation_id;
  pg.durable.get(ap).state = 'approved';
  pg.durable.get(ap).approved_actor_staff_user_id = A;
  send.calls.length = 0;

  await Promise.all([
    routes.handleApproveSend(mockReq(dto({ approval_id: ap })), {}, user(), gate),
    routes.handleApproveSend(mockReq(dto({ approval_id: ap })), {}, user(), gate),
  ]);

  assert.equal(send.calls.length, 2, 'two concurrent approve-send responses');
  assert.ok(send.calls.every((c) => c.status === 200 && c.body && c.body.success === true
    && c.body.error === undefined), 'both responses report provider-committed success');
  assert.ok(dispatches >= 2, 'both invocations reached committed dispatch (journal left empty)');
  const rows = pg.mirrorRowsFor(ap);
  assert.equal(rows.length, 1, 'exactly one durable mirror row for approval');
  assert.equal(rows[0].message_text, BODY);
  assert.equal(rows[0].client_id, C);
  assert.equal(rows[0].conversation_id, V);
  assert.equal(pg.previewTouches, 1, 'preview updated exactly once (insert winner only)');
  assert.equal(pg.previews.get(V).preview, BODY.slice(0, 500));
  assert.equal(pg.previews.get(V).touches, 1);
  console.log('  PASS  concurrent committed same-approval → one row + one preview');

  // Sequential retry after row exists: still one row, no extra preview touch.
  const touchesAfter = pg.previewTouches;
  const insertsAfter = pg.insertCalls;
  send.calls.length = 0;
  await routes.handleApproveSend(mockReq(dto({ approval_id: ap })), {}, user(), gate);
  assert.equal(send.calls[0].status, 200);
  assert.equal(pg.mirrorRowsFor(ap).length, 1, 'retry still one row');
  assert.equal(pg.previewTouches, touchesAfter, 'retry does not rewrite preview');
  assert.ok(pg.insertCalls > insertsAfter, 'retry still attempted insert (ON CONFLICT no-op)');
  console.log('  PASS  sequential committed retry → no preview rewrite');

  // Different approval remains independently insertable.
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const ap2 = send.calls[0].body.approval_id;
  pg.durable.get(ap2).state = 'approved';
  pg.durable.get(ap2).approved_actor_staff_user_id = A;
  send.calls.length = 0;
  await routes.handleApproveSend(mockReq(dto({ approval_id: ap2 })), {}, user(), gate);
  assert.equal(send.calls[0].status, 200);
  assert.equal(pg.mirrorRowsFor(ap2).length, 1, 'second approval has its own row');
  assert.equal(pg.messages.size, 2, 'two approvals → two mirror rows');
  console.log('  PASS  different approvals independently insertable');

  // Foreign tenant / conversation scope cannot collide with same approval_id key space.
  // Directly exercise identity: same approval_id string under foreign client/conversation
  // is a different unique key (client_id + conversation_id + approval_id).
  const foreignKeyClient = `${C2}|${V}|${ap}`;
  const foreignKeyConv = `${C}|${V2}|${ap}`;
  assert.equal(pg.messages.has(foreignKeyClient), false);
  assert.equal(pg.messages.has(foreignKeyConv), false);
  // Insert via the same SQL owner path by seeding a row with foreign scope and calling insert.
  await pg.withPgClient(async (c) => {
    const rForeignClient = await c.query(
      `INSERT INTO messages (
        client_id, conversation_id, direction, message_text, message_type,
        source, route, metadata
      ) VALUES (
        $1::uuid, $2::uuid, 'outbound', $3, 'email',
        'staff_email_reply', 'email', $4::jsonb
      )
      ON CONFLICT (client_id, conversation_id, ((metadata->>'approval_id')))
      WHERE direction = 'outbound'
        AND source = 'staff_email_reply'
        AND route = 'email'
        AND (metadata->>'approval_id') IS NOT NULL
        AND (metadata->>'approval_id') <> ''
      DO NOTHING
      RETURNING id::text AS message_id`,
      [C2, V, 'foreign-tenant body', JSON.stringify({ channel: 'email', approval_id: ap, send_kind: 'staff_email_reply' })],
    );
    const rForeignConv = await c.query(
      `INSERT INTO messages (
        client_id, conversation_id, direction, message_text, message_type,
        source, route, metadata
      ) VALUES (
        $1::uuid, $2::uuid, 'outbound', $3, 'email',
        'staff_email_reply', 'email', $4::jsonb
      )
      ON CONFLICT (client_id, conversation_id, ((metadata->>'approval_id')))
      WHERE direction = 'outbound'
        AND source = 'staff_email_reply'
        AND route = 'email'
        AND (metadata->>'approval_id') IS NOT NULL
        AND (metadata->>'approval_id') <> ''
      DO NOTHING
      RETURNING id::text AS message_id`,
      [C, V2, 'foreign-conv body', JSON.stringify({ channel: 'email', approval_id: ap, send_kind: 'staff_email_reply' })],
    );
    assert.equal(rForeignClient.rows.length, 1, 'foreign client scope inserts independently');
    assert.equal(rForeignConv.rows.length, 1, 'foreign conversation scope inserts independently');
  });
  assert.equal(pg.mirrorRowsFor(ap).length, 3, 'same approval_id across scopes = three rows');
  // Original tenant/conversation row unchanged.
  const home = [...pg.messages.values()].filter((m) => m.client_id === C && m.conversation_id === V && m.approval_id === String(ap).toLowerCase());
  assert.equal(home.length, 1);
  assert.equal(home[0].message_text, BODY);
  console.log('  PASS  foreign tenant/conversation scope cannot collide');

  // Mirror DB failure must not undo or misreport Graph commit.
  const pgFail = createMirrorPg({ mirrorFail: true });
  const sendFail = captureSend();
  let failDispatches = 0;
  const routesFail = createStaffEmailInboxRoutes({
    sendJSON: sendFail.sendJSON,
    withPgClient: pgFail.withPgClient,
    runtimeEnv: enabledEnv(),
    outboundDispatch: async () => {
      failDispatches += 1;
      return Object.freeze({ ok: true, code: 'email_send_committed' });
    },
  });
  await routesFail.handleDraft(mockReq(dto()), {}, user(), gate);
  const apFail = sendFail.calls[0].body.approval_id;
  pgFail.durable.get(apFail).state = 'approved';
  pgFail.durable.get(apFail).approved_actor_staff_user_id = A;
  sendFail.calls.length = 0;
  await routesFail.handleApproveSend(mockReq(dto({ approval_id: apFail })), {}, user(), gate);
  assert.equal(failDispatches, 1);
  assert.equal(sendFail.calls[0].status, 200, 'committed response survives mirror failure');
  assert.equal(sendFail.calls[0].body.success, true);
  assert.equal(sendFail.calls[0].body.error, undefined);
  assert.equal(pgFail.messages.size, 0, 'no mirror row when insert fails');
  assert.equal(pgFail.previewTouches, 0, 'no preview touch when insert fails');
  console.log('  PASS  mirror DB failure leaves committed provider response successful');

  // Source contract: no unlocked SELECT-then-INSERT remains.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'), 'utf8');
  assert.match(src, /ON CONFLICT \(client_id, conversation_id, \(\(metadata->>'approval_id'\)\)\)/);
  assert.match(src, /DO NOTHING/);
  assert.match(src, /messages_staff_email_reply_approval_uq/);
  assert.doesNotMatch(src, /SQL_OUTBOUND_THREAD_EXISTS/);
  assert.match(src, /inserted\.rows\.length !== 1/);
  assert.match(src, /deliveryCommitted === true/);
  console.log('  PASS  source uses ON CONFLICT + conditional preview (no SELECT exists)');
}

async function proveMigrationPglite() {
  console.log('  -- migration 072 pglite --');
  const PGlite = tryLoadPglite();
  assert.ok(PGlite, 'PGlite required for migration proof');
  const up = fs.readFileSync(UP_PATH, 'utf8');
  const down = fs.readFileSync(DOWN_PATH, 'utf8');
  assert.match(up, /messages_staff_email_reply_approval_uq/);
  assert.match(up, /staff_email_reply/);
  assert.match(up, /metadata->>'approval_id'/);
  assert.match(down, /DROP INDEX IF EXISTS messages_staff_email_reply_approval_uq/);

  const db = new PGlite();
  await db.exec(`
    CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
    CREATE TABLE messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID NOT NULL,
      conversation_id UUID NOT NULL,
      direction message_direction NOT NULL,
      message_text TEXT NOT NULL,
      message_type TEXT,
      route TEXT,
      source TEXT NOT NULL DEFAULT 'whatsapp',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE conversations (
      id UUID PRIMARY KEY,
      client_id UUID NOT NULL,
      last_message_preview TEXT,
      last_staff_reply_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );
  `);
  await db.exec(up);

  const insertSql = `
INSERT INTO messages (
  client_id, conversation_id, direction, message_text, message_type,
  source, route, metadata
) VALUES (
  $1::uuid, $2::uuid, 'outbound', $3, 'email',
  'staff_email_reply', 'email', $4::jsonb
)
ON CONFLICT (client_id, conversation_id, ((metadata->>'approval_id')))
WHERE direction = 'outbound'
  AND source = 'staff_email_reply'
  AND route = 'email'
  AND (metadata->>'approval_id') IS NOT NULL
  AND (metadata->>'approval_id') <> ''
DO NOTHING
RETURNING id::text AS message_id
`.replace(/\s+/g, ' ').trim();

  const ap = crypto.randomUUID();
  const meta = JSON.stringify({ channel: 'email', approval_id: ap, send_kind: 'staff_email_reply' });
  const r1 = await db.query(insertSql, [C, V, BODY, meta]);
  const r2 = await db.query(insertSql, [C, V, 'retry body must not insert', meta]);
  assert.equal(r1.rows.length, 1);
  assert.equal(r2.rows.length, 0);
  const n = await db.query(
    `SELECT count(*)::int AS n FROM messages
      WHERE client_id=$1::uuid AND conversation_id=$2::uuid
        AND source='staff_email_reply' AND metadata->>'approval_id'=$3`,
    [C, V, ap],
  );
  assert.equal(n.rows[0].n, 1, 'pglite: one row after insert+conflict');

  // Different approval inserts.
  const apOther = crypto.randomUUID();
  const r3 = await db.query(insertSql, [
    C, V, 'other approval', JSON.stringify({ channel: 'email', approval_id: apOther, send_kind: 'staff_email_reply' }),
  ]);
  assert.equal(r3.rows.length, 1);

  // Foreign scopes independent.
  const r4 = await db.query(insertSql, [
    C2, V, 'foreign client', JSON.stringify({ channel: 'email', approval_id: ap, send_kind: 'staff_email_reply' }),
  ]);
  const r5 = await db.query(insertSql, [
    C, V2, 'foreign conv', JSON.stringify({ channel: 'email', approval_id: ap, send_kind: 'staff_email_reply' }),
  ]);
  assert.equal(r4.rows.length, 1);
  assert.equal(r5.rows.length, 1);

  // WhatsApp / inbound not constrained by the partial unique index.
  await db.query(
    `INSERT INTO messages (client_id, conversation_id, direction, message_text, source, route, metadata)
     VALUES ($1,$2,'outbound','wa','whatsapp','whatsapp',$3::jsonb)`,
    [C, V, JSON.stringify({ approval_id: ap })],
  );
  await db.query(
    `INSERT INTO messages (client_id, conversation_id, direction, message_text, source, route, metadata)
     VALUES ($1,$2,'inbound','in','email_inbound','email',$3::jsonb)`,
    [C, V, JSON.stringify({ approval_id: ap })],
  );
  const total = await db.query('SELECT count(*)::int AS n FROM messages');
  assert.equal(total.rows[0].n, 6, 'unrelated rows unconstrained');

  await db.exec(down);
  const idx = await db.query(
    `SELECT 1 AS ok FROM pg_indexes WHERE indexname = 'messages_staff_email_reply_approval_uq'`,
  );
  assert.equal(idx.rows.length, 0, 'down drops index');
  await db.close();
  console.log('  PASS  072 pglite unique identity + ON CONFLICT + unrelated unconstrained + down');
}

(async () => {
  console.log('verify:staff-email-outbound-thread-mirror-idempotency');

  // RED evidence contract: unlocked SELECT-then-INSERT must not remain.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'), 'utf8');
  assert.match(src, /SQL_INSERT_OUTBOUND_THREAD/);
  assert.match(src, /ON CONFLICT/);
  assert.ok(fs.existsSync(UP_PATH), '072 up migration present');
  assert.ok(fs.existsSync(DOWN_PATH), '072 down migration present');

  await proveApproveSendOwnerIdempotency();
  await proveMigrationPglite();

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:staff-email-outbound-thread-mirror-idempotency'],
    'node scripts/verify-staff-email-outbound-thread-mirror-idempotency.js',
  );

  console.log('PASS staff-email-outbound-thread-mirror-idempotency');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
