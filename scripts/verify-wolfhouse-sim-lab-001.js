'use strict';

/**
 * WOLFHOUSE-SIM-LAB-001 — classification only.
 *
 * Sunset already saves Lab labels on authorized simulator confirmations.
 * Wolfhouse staging simulator provenance must receive the same conversation
 * labels (open_phone_testing / guest_tester_class) without widening Sunset's
 * confirmation-persistence permission or Wolfhouse write/send permissions.
 *
 * Path proved here: mirror → stored labels → Lab list/count → visible rows.
 * Sims excluded from All/WhatsApp. Real convos + Sunset confirmation unchanged.
 *
 * Historical correction of already-misfiled threads is out of scope. A later
 * exact-ID UPDATE of known Wolfhouse simulator conversation ids could stamp
 * the same two metadata keys; this slice does not run or ship that UPDATE.
 *
 * Run: node scripts/verify-wolfhouse-sim-lab-001.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const THREAD_MIRROR = path.join(ROOT, 'scripts/lib/luna-hermes-whatsapp-thread-mirror.js');

const {
  parseHermesWhatsAppThreadMirrorBody,
  isAuthorizedSunsetStagingSyntheticConfirmation,
  isVerifiedWolfhouseStagingSimulatorProvenance,
  mirrorHermesWhatsAppThreadMessage,
} = require('./lib/luna-hermes-whatsapp-thread-mirror');
const {
  CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE,
} = require('./lib/luna-staff-inbox-thread-message');
const {
  sqlConversationOwnerLabPredicate,
  getConversationInboxQuery,
  getConversationInboxCountsQuery,
} = require('./lib/staff-conversation-queries');
const {
  buildInboxViewQuery,
  getInboxSavedViewDeclaration,
} = require('./lib/staff-inbox-saved-views');
const {
  projectInboxPersonRow,
} = require('./lib/staff-inbox-view-routes');

const WOLFHOUSE = 'wolfhouse-somo';
const SUNSET = 'sunset';
const OWNER = 'crowsnest-guest-door';

const wolfhouseStagingEnv = {
  NODE_ENV: 'staging',
  STAFF_API_INGRESS_TENANT_SLUG: WOLFHOUSE,
};

const wolfhouseDefaultSlugEnv = {
  NODE_ENV: 'staging',
  DEFAULT_CLIENT_SLUG: WOLFHOUSE,
};

const sunsetStagingEnv = {
  NODE_ENV: 'staging',
  DEFAULT_CLIENT_SLUG: SUNSET,
  LUNA_DEPLOYMENT: 'sunset-staging',
};

function makeFakePg(opts) {
  const options = opts || {};
  const clients = { sunset: 'client-sunset', 'wolfhouse-somo': 'client-wh' };
  const clientModes = Object.assign(
    { sunset: 'auto', 'wolfhouse-somo': 'auto' },
    options.clientModes || {},
  );
  const conversations = new Map();
  const messages = [];
  const drafts = new Map();
  let msgSeq = 0;
  return {
    messages,
    conversations,
    drafts,
    async query(sql, params) {
      const s = String(sql);
      if (/pg_advisory_(lock|unlock)/.test(s)) return { rows: [] };
      if (/settings->'inbox_channel_modes'->>'whatsapp'/.test(s) || /AS whatsapp_mode/.test(s)) {
        const slug = params[0];
        if (!clients[slug]) return { rows: [] };
        return {
          rows: [{
            client_id: clients[slug],
            whatsapp_mode: clientModes[slug] || 'auto',
          }],
        };
      }
      if (/INSERT INTO luna_outbound_approvals/.test(s)) {
        const approvalId = params[0];
        const clientId = params[1];
        const convId = params[2];
        const key = `${clientId}:${convId}:whatsapp`;
        const existing = drafts.get(key);
        const row = {
          approval_id: existing && existing.status === 'pending' ? existing.approval_id : approvalId,
          conversation_id: convId,
          channel: 'whatsapp',
          draft_text: String(params[3]),
          status: 'pending',
          created_by_run_id: params[5] || null,
        };
        drafts.set(key, row);
        return { rows: [{ ...row }] };
      }
      if (/SELECT id FROM clients WHERE slug/.test(s)) {
        const slug = params[0];
        if (!clients[slug]) return { rows: [] };
        return { rows: [{ id: clients[slug] }] };
      }
      if (/SELECT id::text AS conversation_id FROM conversations WHERE client_id/.test(s)) {
        const key = `${params[0]}:${params[1]}`;
        const found = conversations.get(key);
        return { rows: found ? [{ conversation_id: found.id }] : [] };
      }
      if (/INSERT INTO conversations/.test(s)) {
        const clientId = params[0];
        const phone = params[1];
        const key = `${clientId}:${phone}`;
        let row = conversations.get(key);
        if (!row) {
          row = {
            id: `conv-${conversations.size + 1}`,
            client_id: clientId,
            phone,
            metadata: JSON.parse(params[3] || '{}'),
            needs_human: false,
          };
          conversations.set(key, row);
        } else {
          row.metadata = { ...row.metadata, ...JSON.parse(params[3] || '{}') };
        }
        return { rows: [{ conversation_id: row.id }] };
      }
      if (/SELECT conv\.id, conv\.client_id/.test(s) || /loadConversationClientId/.test(s)) {
        const slug = params[0];
        const convId = params[1];
        const clientId = clients[slug];
        for (const row of conversations.values()) {
          if (row.id === convId && row.client_id === clientId) {
            return { rows: [{ id: row.id, client_id: row.client_id }] };
          }
        }
        return { rows: [] };
      }
      if (/FROM messages m[\s\S]*whatsapp_message_id/.test(s) || /m\.whatsapp_message_id =/.test(s)) {
        const slug = params[0];
        const convId = params[1];
        const waId = params[2];
        const hit = messages.find(
          (m) => m.client_slug === slug && m.conversation_id === convId && m.whatsapp_message_id === waId,
        );
        return {
          rows: hit
            ? [{
              message_id: hit.message_id,
              whatsapp_message_id: hit.whatsapp_message_id,
              source: hit.source,
              direction: hit.direction,
            }]
            : [],
        };
      }
      if (/metadata->>'idempotency_key'/.test(s)) {
        const slug = params[0];
        const convId = params[1];
        const keys = params.slice(2);
        const hit = messages.find((m) => {
          if (m.client_slug !== slug || m.conversation_id !== convId) return false;
          if (keys.includes(m.whatsapp_message_id)) return true;
          if (m.idempotency_key && keys.includes(m.idempotency_key)) return true;
          return false;
        });
        return {
          rows: hit
            ? [{
              message_id: hit.message_id,
              whatsapp_message_id: hit.whatsapp_message_id,
              source: hit.source,
              direction: hit.direction,
            }]
            : [],
        };
      }
      if (/INSERT INTO messages/.test(s)) {
        const direction = /'inbound'/.test(s) ? 'inbound' : 'outbound';
        const source = params[3];
        const synthetic = source === CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE;
        const waId = synthetic ? null : params[4];
        const meta = JSON.parse(params[synthetic ? 4 : (direction === 'inbound' ? 5 : 6)] || '{}');
        msgSeq += 1;
        const clientId = params[0];
        const row = {
          message_id: `msg-${msgSeq}`,
          client_id: clientId,
          conversation_id: params[1],
          message_text: params[2],
          source,
          whatsapp_message_id: waId,
          direction,
          idempotency_key: meta.idempotency_key || null,
          client_slug: Object.keys(clients).find((k) => clients[k] === clientId),
        };
        messages.push(row);
        return {
          rows: [{
            message_id: row.message_id,
            whatsapp_message_id: row.whatsapp_message_id,
            source: row.source,
            direction: row.direction,
          }],
        };
      }
      return { rows: [] };
    },
  };
}

function wolfhouseSimBody(overrides) {
  return parseHermesWhatsAppThreadMirrorBody({
    client_slug: WOLFHOUSE,
    guest_phone: '+99900000001',
    direction: 'inbound',
    message_text: 'wolfhouse sim hello',
    whatsapp_message_id: 'wamid.WH-SIM-1',
    contact_name: 'WH Sim',
    simulator_synthetic: true,
    source_owner: OWNER,
    simulator_source_phone: '+34600111222',
    ...overrides,
  });
}

function conversationMeta(pg) {
  const rows = [...pg.conversations.values()];
  assert.equal(rows.length, 1, 'expected one conversation');
  return rows[0].metadata || {};
}

async function seedInboxLabDb(rows) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id text PRIMARY KEY, slug text NOT NULL);
    CREATE TABLE conversations (
      id text PRIMARY KEY,
      client_id text NOT NULL REFERENCES clients(id),
      phone text,
      display_name text,
      email text,
      language text,
      bot_mode text,
      needs_human boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'open',
      conversation_stage text,
      last_message_preview text,
      pending_action text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      session_state jsonb NOT NULL DEFAULT '{}'::jsonb,
      current_hold_booking_id text,
      customer_id text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE messages (
      id text PRIMARY KEY,
      client_id text,
      conversation_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      direction text,
      source text,
      route text,
      metadata jsonb
    );
    CREATE TABLE staff_handoffs (
      conversation_id text,
      status text,
      reason_code text,
      priority text,
      opened_at timestamptz
    );
    CREATE TABLE bot_pause_states (
      conversation_id text,
      client_slug text,
      paused boolean,
      paused_at timestamptz
    );
    CREATE TABLE bookings (
      id text PRIMARY KEY,
      client_id text,
      phone text,
      guest_name text,
      booking_code text,
      created_at timestamptz
    );
    CREATE TABLE customers (
      id text PRIMARY KEY,
      client_id text,
      phone text
    );
    INSERT INTO clients (id, slug) VALUES ('client-wh', 'wolfhouse-somo');
  `);
  for (const row of rows) {
    await db.query(
      `INSERT INTO conversations (
         id, client_id, phone, display_name, status, metadata, session_state
       ) VALUES ($1, 'client-wh', $2, $3, 'open', $4::jsonb, '{}'::jsonb)`,
      [row.id, row.phone, row.display_name || row.id, JSON.stringify(row.metadata || {})],
    );
  }
  return db;
}

async function main() {
  assert.equal(
    typeof isVerifiedWolfhouseStagingSimulatorProvenance,
    'function',
    'shared mirror exports Wolfhouse staging simulator classification',
  );

  const parsed = wolfhouseSimBody();
  assert.equal(parsed.ok, true);
  assert.equal(parsed.input.simulator_synthetic, true);
  assert.equal(parsed.input.source_owner, OWNER);

  assert.equal(
    isVerifiedWolfhouseStagingSimulatorProvenance(parsed.input, wolfhouseStagingEnv),
    true,
    'ingress-identified Wolfhouse staging admits simulator provenance',
  );
  assert.equal(
    isVerifiedWolfhouseStagingSimulatorProvenance(parsed.input, wolfhouseDefaultSlugEnv),
    true,
    'DEFAULT_CLIENT_SLUG=wolfhouse-somo staging admits simulator provenance',
  );

  assert.equal(
    isVerifiedWolfhouseStagingSimulatorProvenance(parsed.input, {}),
    false,
    'empty env is not verified Wolfhouse staging',
  );
  assert.equal(
    isVerifiedWolfhouseStagingSimulatorProvenance(parsed.input, {
      ...wolfhouseStagingEnv, NODE_ENV: 'production',
    }),
    false,
  );
  assert.equal(
    isVerifiedWolfhouseStagingSimulatorProvenance(parsed.input, {
      ...wolfhouseStagingEnv, LUNA_DEPLOYMENT: 'sunset-staging', DEFAULT_CLIENT_SLUG: SUNSET,
    }),
    false,
  );
  assert.equal(
    isVerifiedWolfhouseStagingSimulatorProvenance({
      ...parsed.input, source_owner: 'attacker',
    }, wolfhouseStagingEnv),
    false,
  );
  assert.equal(
    isVerifiedWolfhouseStagingSimulatorProvenance({
      ...parsed.input, simulator_synthetic: false,
    }, wolfhouseStagingEnv),
    false,
  );
  assert.equal(
    isVerifiedWolfhouseStagingSimulatorProvenance({
      ...parsed.input, client_slug: SUNSET,
    }, wolfhouseStagingEnv),
    false,
  );

  const sunsetClaim = parseHermesWhatsAppThreadMirrorBody({
    client_slug: SUNSET,
    location_id: 'sunset-somo',
    guest_phone: '+34600111222',
    direction: 'outbound',
    message_text: 'Confirmed',
    idempotency_key: 'synthetic-wh-lab-1',
    simulator_synthetic: true,
    source_owner: OWNER,
  });
  assert.equal(
    isAuthorizedSunsetStagingSyntheticConfirmation(sunsetClaim.input, sunsetStagingEnv),
    true,
    'Sunset confirmation-persistence permission stays granted on Sunset staging',
  );
  assert.equal(
    isAuthorizedSunsetStagingSyntheticConfirmation(parsed.input, wolfhouseStagingEnv),
    false,
    'Wolfhouse staging does not inherit Sunset confirmation-persistence',
  );
  assert.equal(
    isAuthorizedSunsetStagingSyntheticConfirmation(parsed.input, sunsetStagingEnv),
    false,
    'Wolfhouse payload cannot use Sunset confirmation-persistence',
  );
  assert.equal(
    isAuthorizedSunsetStagingSyntheticConfirmation(sunsetClaim.input, wolfhouseStagingEnv),
    false,
  );

  const simPg = makeFakePg();
  const simOut = await mirrorHermesWhatsAppThreadMessage(simPg, parsed.input, {
    env: wolfhouseStagingEnv,
  });
  assert.equal(simOut.ok, true, 'Wolfhouse staging sim mirrors');
  const simMeta = conversationMeta(simPg);
  assert.equal(simMeta.open_phone_testing, true, 'stored Lab flag open_phone_testing');
  assert.equal(simMeta.guest_tester_class, 'Simulator', 'stored Lab class Simulator');
  assert.equal(simMeta.simulator_synthetic, true);
  assert.equal(simMeta.source_owner, OWNER);

  const realParsed = parseHermesWhatsAppThreadMirrorBody({
    client_slug: WOLFHOUSE,
    guest_phone: '+34600999888',
    direction: 'inbound',
    message_text: 'real guest hello',
    whatsapp_message_id: 'wamid.WH-REAL-1',
    contact_name: 'Real Guest',
  });
  const realPg = makeFakePg();
  const realOut = await mirrorHermesWhatsAppThreadMessage(realPg, realParsed.input, {
    env: wolfhouseStagingEnv,
  });
  assert.equal(realOut.ok, true);
  const realMeta = conversationMeta(realPg);
  assert.equal(realMeta.open_phone_testing, undefined);
  assert.equal(realMeta.guest_tester_class, undefined);
  assert.notEqual(realMeta.simulator_synthetic, true);

  const sunsetSimPg = makeFakePg();
  const sunsetInbound = parseHermesWhatsAppThreadMirrorBody({
    client_slug: SUNSET,
    location_id: 'sunset-somo',
    guest_phone: '+99900000002',
    direction: 'inbound',
    message_text: 'sunset sim hello',
    whatsapp_message_id: 'wamid.SUN-SIM-1',
    simulator_synthetic: true,
    source_owner: OWNER,
  });
  const sunsetSimOut = await mirrorHermesWhatsAppThreadMessage(
    sunsetSimPg,
    sunsetInbound.input,
    { env: sunsetStagingEnv },
  );
  assert.equal(sunsetSimOut.ok, true);
  const sunsetMeta = conversationMeta(sunsetSimPg);
  assert.equal(sunsetMeta.open_phone_testing, true, 'Sunset sim labels unchanged');
  assert.equal(sunsetMeta.guest_tester_class, 'Simulator');

  const ownerLabPredicate = sqlConversationOwnerLabPredicate('conv');
  const allBuilt = buildInboxViewQuery({ view: 'all', clientSlug: WOLFHOUSE, query: {} });
  const waBuilt = buildInboxViewQuery({ view: 'whatsapp', clientSlug: WOLFHOUSE, query: {} });
  const labBuilt = buildInboxViewQuery({ view: 'owner_lab', clientSlug: WOLFHOUSE, query: {} });
  assert.equal(allBuilt.ok, true);
  assert.equal(waBuilt.ok, true);
  assert.equal(labBuilt.ok, true);
  assert.equal(getInboxSavedViewDeclaration('owner_lab').ownerLab, true);
  assert.ok(allBuilt.sql.includes(`AND NOT ${ownerLabPredicate}`), 'All excludes Lab');
  assert.ok(waBuilt.sql.includes(`AND NOT ${ownerLabPredicate}`), 'WhatsApp excludes Lab');
  assert.ok(labBuilt.sql.includes(`AND ${ownerLabPredicate}`), 'Lab keeps labeled rows');
  assert.ok(!labBuilt.sql.includes(`AND NOT ${ownerLabPredicate}`));

  const db = await seedInboxLabDb([
    {
      id: 'conv-sim',
      phone: '+99900000001',
      display_name: 'WH Sim',
      metadata: simMeta,
    },
    {
      id: 'conv-real',
      phone: '+34600999888',
      display_name: 'Real Guest',
      metadata: realMeta,
    },
  ]);
  try {
    const pred = await db.query(`
      SELECT id, ${ownerLabPredicate} AS is_lab
      FROM conversations conv
      ORDER BY id
    `);
    const byId = Object.fromEntries(pred.rows.map((r) => [r.id, r.is_lab]));
    assert.equal(byId['conv-sim'], true, 'stored sim metadata matches Lab predicate');
    assert.equal(byId['conv-real'], false, 'real convo stays ordinary');

    const countsSql = getConversationInboxCountsQuery({
      columns: [
        { key: 'all', channel: null },
        { key: 'whatsapp', channel: 'whatsapp' },
        { key: 'owner_lab', channel: null, ownerLab: true },
      ],
    });
    const counts = await db.query(countsSql, [WOLFHOUSE, 'whatsapp']);
    assert.equal(counts.rows.length, 1);
    assert.equal(counts.rows[0].all, 1, 'All count is the real convo only');
    assert.equal(counts.rows[0].whatsapp, 1, 'WhatsApp count is the real convo only');
    assert.equal(counts.rows[0].owner_lab, 1, 'Lab count is the sim convo only');

    const labListSql = getConversationInboxQuery({
      ownerLabScoped: true,
      includeEmailSubject: false,
    });
    const labList = await db.query(labListSql, [WOLFHOUSE]);
    assert.equal(labList.rows.length, 1, 'Lab list shows one visible row');
    assert.equal(labList.rows[0].conversation_id, 'conv-sim');
    assert.equal(labList.rows[0].open_phone_testing, true);
    assert.equal(labList.rows[0].guest_tester_class, 'Simulator');

    const allListSql = getConversationInboxQuery({ includeEmailSubject: false });
    const allList = await db.query(allListSql, [WOLFHOUSE]);
    assert.equal(allList.rows.length, 1, 'All list hides the sim row');
    assert.equal(allList.rows[0].conversation_id, 'conv-real');

    const waListSql = getConversationInboxQuery({
      channelScoped: true,
      includeEmailSubject: false,
    });
    const waList = await db.query(waListSql, [WOLFHOUSE, 'whatsapp']);
    assert.equal(waList.rows.length, 1, 'WhatsApp list hides the sim row');
    assert.equal(waList.rows[0].conversation_id, 'conv-real');

    const visible = projectInboxPersonRow(
      { source: 'conversations', id: 'owner_lab' },
      labList.rows[0],
    );
    assert.equal(visible.open_phone_testing, true);
    assert.equal(visible.guest_tester_class, 'Simulator');
    assert.equal(visible.conversation_id, 'conv-sim');
  } finally {
    await db.close();
  }

  const offPg = makeFakePg({ clientModes: { 'wolfhouse-somo': 'off' } });
  const offOut = await mirrorHermesWhatsAppThreadMessage(offPg, {
    ...parsed.input,
    direction: 'outbound',
    message_text: 'should not persist confirmation',
    idempotency_key: 'wh-sim-off-1',
  }, { env: wolfhouseStagingEnv });
  assert.equal(offOut.thread && offOut.thread.suppressed, true, 'Wolfhouse Off stays suppressed');
  assert.equal(
    offPg.messages.filter((m) => m.source === CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE).length,
    0,
    'Wolfhouse classification does not grant confirmation persistence',
  );
  assert.equal(offPg.drafts.size, 0, 'Wolfhouse sim Off stages no approval');

  const sunsetOffPg = makeFakePg({ clientModes: { sunset: 'off' } });
  const sunsetOff = await mirrorHermesWhatsAppThreadMessage(sunsetOffPg, {
    ...sunsetClaim.input,
    guest_phone: '+34600004444',
    idempotency_key: 'sunset-off-keep-1',
  }, { env: sunsetStagingEnv });
  assert.equal(sunsetOff.thread && sunsetOff.thread.persisted, true);
  assert.equal(
    sunsetOffPg.messages.filter((m) => m.source === CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE).length,
    1,
    'Sunset confirmation-persistence permission is unchanged',
  );

  const mirrorSrc = fs.readFileSync(THREAD_MIRROR, 'utf8');
  assert.equal(
    /UPDATE\s+conversations[\s\S]{0,400}open_phone_testing/.test(mirrorSrc),
    false,
    'no historical conversation backfill in this slice',
  );

  console.log('PASS verify-wolfhouse-sim-lab-001: Wolfhouse staging sim labels Lab; All/WhatsApp exclude; Sunset persistence unchanged');
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
