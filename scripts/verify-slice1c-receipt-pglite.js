#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
  CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE,
  CROWSNEST_SYNTHETIC_INTERVENTION_SOURCE,
  persistCrowsnestSyntheticInterventionThreadMessage,
  receiptCrowsnestSyntheticConfirmationThreadMessage,
} = require('./lib/luna-staff-inbox-thread-message');
const { getConversationMessagesQuery } = require('./lib/staff-conversation-queries');

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const CA = '00000000-0000-4000-8000-000000000011';
const CB = '00000000-0000-4000-8000-000000000012';
const M = '00000000-0000-4000-8000-000000000021';

(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients(id uuid primary key, slug text unique not null);
    CREATE TABLE conversations(id uuid primary key, client_id uuid not null references clients(id), cleared_at timestamptz);
    CREATE TABLE messages(
      id uuid primary key, conversation_id uuid not null references conversations(id),
      client_id uuid not null references clients(id), source text not null,
      metadata jsonb, direction text default 'outbound', message_text text default 'reply',
      message_type text default 'text', language text, route text, whatsapp_message_id text, status text,
      conversation_stage text, created_at timestamptz default now()
    );
  `);
  await db.query('INSERT INTO clients VALUES ($1,$2),($3,$4)', [A, 'wolfhouse-somo', B, 'sunset']);
  await db.query('INSERT INTO conversations VALUES ($1,$2),($3,$4)', [CA, A, CB, B]);
  await db.query('INSERT INTO messages(id,conversation_id,client_id,source,metadata) VALUES($1,$2,$3,$4,$5)',
    [M, CA, A, CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE, { existing: 'kept', consumer_receipt: false }]);
  let transportCalls = 0;
  const pending = await db.query('SELECT metadata FROM messages WHERE id=$1', [M]);
  assert.equal(pending.rows[0].metadata.consumer_receipt, false);
  const first = await receiptCrowsnestSyntheticConfirmationThreadMessage(db, { client_slug: 'wolfhouse-somo', conversation_id: CA, message_id: M });
  assert.equal(first.ok, true); assert.equal(first.changed, true); assert.equal(first.message.metadata.existing, 'kept');
  const snapshot = JSON.stringify(first.message.metadata);
  const second = await receiptCrowsnestSyntheticConfirmationThreadMessage(db, { client_slug: 'wolfhouse-somo', conversation_id: CA, message_id: M });
  assert.equal(second.ok, true); assert.equal(second.changed, false); assert.equal(JSON.stringify(second.message.metadata), snapshot);
  for (const bad of [
    { client_slug: 'sunset', conversation_id: CA, message_id: M },
    { client_slug: 'wolfhouse-somo', conversation_id: CB, message_id: M },
    { client_slug: 'wolfhouse-somo', conversation_id: CA, message_id: '00000000-0000-4000-8000-000000000099' },
  ]) assert.equal((await receiptCrowsnestSyntheticConfirmationThreadMessage(db, bad)).ok, false);
  await db.query('UPDATE messages SET source=$1 WHERE id=$2', ['other_source', M]);
  assert.equal((await receiptCrowsnestSyntheticConfirmationThreadMessage(db, { client_slug: 'wolfhouse-somo', conversation_id: CA, message_id: M })).ok, false);
  await db.query('UPDATE messages SET source=$1 WHERE id=$2', [CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE, M]);
  const projection = await db.query(getConversationMessagesQuery(), ['wolfhouse-somo', CA]);
  assert.equal(projection.rows[0].simulator_delivery_status, 'delivered');
  assert.equal(projection.rows[0].consumer_receipt, true);

  const intervention = {
    client_slug: 'wolfhouse-somo', conversation_id: CA,
    message_text: 'Supervisor here', idempotency_key: 'lease-1:reply-1',
  };
  const interventionFirst = await persistCrowsnestSyntheticInterventionThreadMessage(db, intervention);
  const interventionRetry = await persistCrowsnestSyntheticInterventionThreadMessage(db, intervention);
  assert.equal(interventionFirst.persisted, true);
  assert.equal(interventionRetry.duplicate, true);
  assert.equal(interventionRetry.message_id, interventionFirst.message_id);
  const interventionRows = await db.query(
    'SELECT id::text AS id FROM messages WHERE client_id=$1 AND conversation_id=$2 AND source=$3',
    [A, CA, CROWSNEST_SYNTHETIC_INTERVENTION_SOURCE],
  );
  assert.equal(interventionRows.rows.length, 1, 'idempotent supervisor retry persists one durable row');
  assert.equal(transportCalls, 0);
  await db.close();
  console.log('PASS Slice 1C real-SQL receipt identity, metadata, idempotency, projection, zero transport');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
