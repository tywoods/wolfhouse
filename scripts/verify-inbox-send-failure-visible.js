#!/usr/bin/env node
'use strict';

/**
 * Writer + getConversationDetailQuery() against throwaway Postgres.
 * Newest send-failure reason + THAT handoff's booking; hold booking stays
 * on the booking card; unrelated urgent handoff is kept.
 *
 * Never uses staging/prod DATABASE_URL.
 */
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const { markConversationNeedsHuman } = require('../scripts/lib/luna-guest-handoff-persist');
const { getConversationDetailQuery } = require('../scripts/lib/staff-conversation-queries');

const CONV_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const REASON = 'whatsapp_send_failed:WH-20270310-13389959';
const BOOKING = 'WH-20270310-13389959';
const HOLD_BOOKING = 'WH-HOLD-OTHER';
const HUMAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOLD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PHONE = '+34911111111';
const SCRATCH_PREFIX = path.join(os.tmpdir(), 'inbox-pg-scratch');

function loadReasonText() {
  const src = fs.readFileSync(path.join(__dirname, 'browser/inbox-luna-mode.js'), 'utf8');
  const start = src.indexOf('function inboxNeedsHumanReasonCode');
  const end = src.indexOf('function inboxNeedsHumanRaiseHtml');
  assert.ok(start >= 0 && end > start, 'inbox reason renderer present');
  const sandbox = {
    t: (_k, fb) => fb || '',
    conversationHasOpenHandoff: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${src.slice(start, end)}\nthis.inboxNeedsHumanReasonText = inboxNeedsHumanReasonText;`,
    sandbox,
  );
  return sandbox.inboxNeedsHumanReasonText;
}

function assertLocalThrowaway(url) {
  const parsed = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'throwaway Postgres must be loopback');
  const db = parsed.pathname.replace(/^\//, '');
  assert.match(db, /throwaway|test|disposable/i, 'database name must be throwaway');
  assert.doesNotMatch(parsed.host, /lunafrontdesk|azure|prod|staging/i);
}

function ensureScratchModules() {
  const pgJs = path.join(SCRATCH_PREFIX, 'node_modules', 'pg');
  const bin = path.join(SCRATCH_PREFIX, 'node_modules', '@embedded-postgres', 'linux-x64', 'native', 'bin');
  if (!fs.existsSync(pgJs) || !fs.existsSync(path.join(bin, 'postgres'))) {
    fs.mkdirSync(SCRATCH_PREFIX, { recursive: true });
    const r = spawnSync('npm', ['install', 'pg@8.13.1', '@embedded-postgres/linux-x64', '--no-save', '--prefix', SCRATCH_PREFIX], {
      encoding: 'utf8',
      timeout: 120000,
    });
    if (r.status !== 0) {
      throw new Error(`npm install scratch pg failed: ${r.stderr || r.stdout}`);
    }
  }
  return {
    pg: createRequire(path.join(SCRATCH_PREFIX, 'node_modules', 'pg', 'package.json'))('pg'),
    bin,
  };
}

function startThrowawayPostgres(bin) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-throwaway-pg-'));
  execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth=trust', '-U', 'postgres', '--locale=C', '--encoding=UTF8'], {
    stdio: 'pipe',
  });
  const port = 55000 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
  execFileSync(path.join(bin, 'pg_ctl'), [
    '-D', dataDir,
    '-l', path.join(dataDir, 'pg.log'),
    '-o', `-p ${port} -k ${dataDir} --listen-addresses=127.0.0.1`,
    'start',
  ], { stdio: 'pipe' });
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  return {
    url,
    port,
    dataDir,
    bin,
    stop() {
      try {
        execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'pipe' });
      } catch (_) { /* already stopped */ }
    },
  };
}

const SCHEMA_SQL = `
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL
);
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  phone TEXT
);
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  booking_code TEXT,
  status TEXT DEFAULT 'confirmed',
  payment_status TEXT DEFAULT 'unpaid',
  check_in DATE,
  check_out DATE,
  guest_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  phone TEXT,
  display_name TEXT,
  email TEXT,
  language TEXT,
  bot_mode TEXT DEFAULT 'bot',
  needs_human BOOLEAN DEFAULT FALSE,
  needs_human_transition_id UUID,
  status TEXT DEFAULT 'open',
  conversation_stage TEXT,
  pending_action TEXT,
  last_message_preview TEXT,
  last_bot_reply TEXT,
  staff_reply_draft TEXT,
  human_notes TEXT,
  internal_staff_notes TEXT,
  last_staff_reply_at TIMESTAMPTZ,
  conversation_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  session_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  customer_id UUID,
  current_hold_booking_id UUID
);
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID,
  conversation_id UUID,
  direction TEXT,
  source TEXT,
  route TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE tenant_email_inbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID,
  subject TEXT,
  received_at TIMESTAMPTZ
);
CREATE TABLE tenant_email_inbound_inbox_projections (
  client_id UUID,
  conversation_id UUID,
  inbound_event_id UUID
);
CREATE TABLE staff_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  conversation_id UUID REFERENCES conversations(id),
  booking_id UUID,
  phone TEXT,
  source_channel TEXT NOT NULL DEFAULT 'whatsapp',
  reason_code TEXT NOT NULL,
  summary TEXT,
  guest_message TEXT,
  language TEXT DEFAULT 'en',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_staff TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_response_due_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution_summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_staff_handoffs_conv_reason_open
  ON staff_handoffs (client_id, conversation_id, reason_code)
  WHERE conversation_id IS NOT NULL
    AND status IN ('open', 'assigned', 'waiting_guest');
CREATE TABLE bot_pause_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug TEXT NOT NULL,
  guest_phone TEXT,
  conversation_id TEXT,
  booking_id UUID,
  booking_code TEXT,
  paused BOOLEAN NOT NULL DEFAULT TRUE,
  pause_reason TEXT,
  paused_by TEXT NOT NULL,
  paused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resumed_by TEXT,
  resumed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function main() {
  const reasonText = loadReasonText();
  const { pg, bin } = ensureScratchModules();
  const cluster = startThrowawayPostgres(bin);
  const admin = new pg.Client({ connectionString: cluster.url });
  let client;
  try {
    await admin.connect();
    await admin.query('CREATE DATABASE throwaway_inbox_1556');
    await admin.end();
    const dbUrl = `postgres://postgres@127.0.0.1:${cluster.port}/throwaway_inbox_1556`;
    assertLocalThrowaway(dbUrl);
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(SCHEMA_SQL);
    await client.query(
      `INSERT INTO clients (id, slug) VALUES ($1, 'wolfhouse-somo')`,
      [CLIENT_ID],
    );
    await client.query(
      `INSERT INTO bookings (id, client_id, booking_code, phone)
       VALUES ($1, $2, $3, $4)`,
      [HOLD_ID, CLIENT_ID, HOLD_BOOKING, PHONE],
    );
    await client.query(
      `INSERT INTO conversations (
         id, client_id, phone, display_name, needs_human, metadata, current_hold_booking_id
       ) VALUES ($1, $2, $3, 'Kathi', TRUE, $4::jsonb, $5)`,
      [CONV_ID, CLIENT_ID, PHONE, JSON.stringify({ needs_human_reason: 'human_requested' }), HOLD_ID],
    );
    await client.query(
      `INSERT INTO staff_handoffs (
         id, client_id, conversation_id, reason_code, summary, priority, status, opened_at, updated_at
       ) VALUES ($1, $2, $3, 'human_requested', 'Guest asked for a human', 'urgent', 'open',
                 '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')`,
      [HUMAN_ID, CLIENT_ID, CONV_ID],
    );

    await markConversationNeedsHuman(client, {
      conversation_id: CONV_ID,
      client_slug: 'wolfhouse-somo',
      reason: REASON,
      booking_code: BOOKING,
    }, { skip_notify: true });

    const kept = await client.query(
      `SELECT reason_code, priority, status FROM staff_handoffs WHERE id = $1`,
      [HUMAN_ID],
    );
    assert.equal(kept.rows[0].reason_code, 'human_requested');
    assert.equal(kept.rows[0].priority, 'urgent');
    assert.equal(kept.rows[0].status, 'open');

    const detailSql = getConversationDetailQuery();
    const detail = await client.query(detailSql, ['wolfhouse-somo', CONV_ID]);
    const row = detail.rows[0];
    assert.ok(row, 'detail query returned a row');
    assert.equal(row.booking_code, HOLD_BOOKING, 'booking card identity stays the hold booking');
    assert.equal(row.handoff_priority, 'urgent', 'queue priority stays on the unrelated handoff');
    assert.match(String(row.handoff_reason || ''), /whatsapp_send_failed/);
    assert.equal(row.handoff_booking_code, BOOKING, 'shown booking is bound to the selected handoff');

    const shown = reasonText(row);
    assert.match(shown, /whatsapp send failed|whatsapp_send_failed/i);
    assert.match(shown, /WH-20270310-13389959/);
    assert.doesNotMatch(shown, /WH-HOLD-OTHER/);

    console.log('ok throwaway postgres detail query shows send-failure booking, not hold booking');
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
    cluster.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
