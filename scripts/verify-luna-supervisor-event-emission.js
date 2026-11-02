#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildLunaSupervisorEvent,
  emitLunaSupervisorEvent,
  captureFailedWhatsAppDeliveryStatus,
  isFranceWolfhouseStaging,
} = require('./lib/luna-supervisor-event-emitter');
const { evaluateGuestReplySendRouteWithPause } = require('./lib/luna-guest-reply-send-route');

const STAGING_ENV = Object.freeze({
  NODE_ENV: 'staging',
  STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo',
  SUPERVISOR_EVENT_SOURCE_ENVIRONMENT: 'france-wolfhouse-staging',
  WHATSAPP_PHONE_NUMBER_ID: 'wh-phone-id',
});

function memoryPg() {
  const events = [];
  return {
    events,
    async connect() { throw new Error('Client has already been connected. You cannot reuse a client.'); },
    release() { throw new Error('borrowed client must not be released'); },
    async query(sql, params) {
      const text = String(sql);
      if (/FROM clients c[\s\S]*JOIN conversations conv/i.test(text)) {
        return { rows: [{ client_id: '11111111-1111-4111-8111-111111111111', conversation_id: '22222222-2222-4222-8222-222222222222' }] };
      }
      if (/INSERT INTO supervisor_events/i.test(text)) {
        const sourceKey = params[7];
        const existing = events.find((row) => row.source_key === sourceKey);
        if (existing) return { rows: [] };
        const row = {
          id: `event-${events.length + 1}`,
          client_id: params[0], conversation_id: params[1], booking_id: params[2], booking_code: params[3],
          kind: params[4], reason: params[5], obligation: params[6], source_key: sourceKey,
          cause_incident_id: params[8], metadata: JSON.parse(params[9]),
        };
        events.push(row);
        return { rows: [row] };
      }
      if (/SELECT \* FROM supervisor_events WHERE source_key/i.test(text)) {
        return { rows: events.filter((row) => row.source_key === params[0]) };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

async function verifyAmbiguousPhoneScopeDoesNotPickNewestConversation() {
  let eventWrites = 0;
  const pg = {
    async query(sql) {
      const text = String(sql);
      if (/^SAVEPOINT /i.test(text) || /^RELEASE SAVEPOINT /i.test(text)) return { rows: [] };
      if (/FROM clients c[\s\S]*JOIN conversations conv/i.test(text)) {
        return { rows: [
          { client_id: '11111111-1111-4111-8111-111111111111', conversation_id: '22222222-2222-4222-8222-222222222222' },
          { client_id: '11111111-1111-4111-8111-111111111111', conversation_id: '33333333-3333-4333-8333-333333333333' },
        ] };
      }
      if (/INSERT INTO supervisor_events/i.test(text)) { eventWrites += 1; return { rows: [] }; }
      throw new Error(`unexpected ambiguous-scope SQL: ${text}`);
    },
  };
  const out = await emitLunaSupervisorEvent(pg, {
    kind: 'luna_send_failed', client_slug: 'wolfhouse-somo', row_id: 'ambiguous-send',
    revision: '1', guest_phone: '+34600000000', blocked_reasons: ['provider_failed'],
  }, { env: STAGING_ENV });
  assert.equal(out.error, 'supervisor_event_conversation_ambiguous');
  assert.equal(eventWrites, 0, 'ambiguous phone scope never picks the newest thread');
}

async function verifyCaptureRollbackIsFailSoft() {
  const queries = [];
  let rolledBack = false;
  const pg = {
    async query(sql) {
      const text = String(sql);
      queries.push(text);
      if (/^SAVEPOINT /i.test(text)) return { rows: [] };
      if (/^ROLLBACK TO SAVEPOINT /i.test(text)) { rolledBack = true; return { rows: [] }; }
      if (/^RELEASE SAVEPOINT /i.test(text)) return { rows: [] };
      if (/FROM clients c[\s\S]*JOIN conversations conv/i.test(text)) {
        return { rows: [{ client_id: '11111111-1111-4111-8111-111111111111', conversation_id: '22222222-2222-4222-8222-222222222222' }] };
      }
      if (/INSERT INTO supervisor_events/i.test(text)) throw new Error('relation missing');
      if (/SELECT 1/i.test(text)) return { rows: [{ '?column?': 1 }] };
      throw new Error(`unexpected rollback SQL: ${text}`);
    },
  };
  const failed = await emitLunaSupervisorEvent(pg, {
    kind: 'luna_send_failed', client_slug: 'wolfhouse-somo', row_id: 'row-fail', revision: '1',
    guest_phone: '+346****0000', blocked_reasons: ['provider_failed'],
  }, { env: STAGING_ENV });
  assert.equal(failed.error, 'supervisor_event_capture_failed');
  assert.equal(Object.hasOwn(failed, 'detail'), false, 'capture result never exposes driver or DSN text');
  assert.equal(rolledBack, true, 'capture SQL failure rolls back to its savepoint');
  const after = await pg.query('SELECT 1');
  assert.equal(after.rows.length, 1, 'caller transaction remains usable');
  assert.ok(queries.some((sql) => /^RELEASE SAVEPOINT /i.test(sql)));
}

async function verifySendRouteFailureEmission() {
  const sendId = '33333333-3333-4333-8333-333333333333';
  const updatedAt = new Date('2026-11-01T23:10:00.000Z');
  const events = [];
  let scopeConversationId = null;
  const pg = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT[\s\S]*FROM guest_message_sends/i.test(text)) return { rows: [] };
      if (/FROM bot_pause_states/i.test(text)) return { rows: [] };
      if (/INSERT INTO guest_message_sends/i.test(text)) {
        return { rows: [{
          id: sendId, client_slug: 'wolfhouse-somo', channel: 'whatsapp',
          to_phone: '+346****0000', idempotency_key: 'send-failure-1',
          send_kind: 'confirmation', source: 'luna', message_text: 'confirmation',
          status: 'pending', blocked_reasons: [], provider_message_id: null,
          provider_response: null, created_at: updatedAt, sent_at: null, updated_at: updatedAt,
        }] };
      }
      if (/UPDATE guest_message_sends[\s\S]*SET status = 'blocked'/i.test(text)) {
        return { rows: [{
          id: sendId, client_slug: 'wolfhouse-somo', channel: 'whatsapp',
          to_phone: '+346****0000', idempotency_key: 'send-failure-1',
          send_kind: 'confirmation', source: 'luna', message_text: 'confirmation',
          status: 'blocked', blocked_reasons: JSON.parse(params[1]), provider_message_id: null,
          provider_response: null, created_at: updatedAt, sent_at: null, updated_at: updatedAt,
        }] };
      }
      if (/FROM clients c[\s\S]*JOIN conversations conv/i.test(text)) {
        scopeConversationId = params[1];
        return { rows: [{
          client_id: '11111111-1111-4111-8111-111111111111',
          conversation_id: '22222222-2222-4222-8222-222222222222',
        }] };
      }
      if (/INSERT INTO supervisor_events/i.test(text)) {
        const row = { source_key: params[7], cause_incident_id: params[8], booking_code: params[3], reason: params[5] };
        events.push(row);
        return { rows: [row] };
      }
      throw new Error(`unexpected send-route SQL: ${text}`);
    },
  };
  const out = await evaluateGuestReplySendRouteWithPause({
    client_slug: 'wolfhouse-somo', conversation_id: '22222222-2222-4222-8222-222222222222',
    to: '+346****0000', idempotency_key: 'send-failure-1',
    suggested_reply: 'confirmation', send_kind: 'confirmation', booking_code: 'WH-45',
  }, {
    pg,
    env: { ...STAGING_ENV, LUNA_AUTO_SEND_ENABLED: 'true', WHATSAPP_DRY_RUN: 'false' },
    incident_id: '44444444-4444-4444-8444-444444444444',
    sendMessage: async () => ({ success: false, blocked_reason: 'meta_destination_rejected' }),
  });
  assert.equal(out.result.send_performed, false);
  assert.equal(out.result.supervisor_event_capture.inserted, true);
  assert.equal(events.length, 1);
  assert.equal(scopeConversationId, '22222222-2222-4222-8222-222222222222',
    'send occurrence binds the authoritative conversation instead of phone-newest lookup');
  assert.equal(events[0].booking_code, 'WH-45');
  assert.equal(events[0].cause_incident_id, '44444444-4444-4444-8444-444444444444');
  assert.match(events[0].reason, /meta_destination_rejected/);
}

async function verifyGateBlockPersistsOccurrenceBeforeCapture() {
  const updatedAt = new Date('2026-11-01T23:11:00.000Z');
  let persistedObligation = null;
  const pg = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT[\s\S]*FROM guest_message_sends/i.test(text)) return { rows: [] };
      if (/FROM bot_pause_states/i.test(text)) return { rows: [] };
      if (/INSERT INTO guest_message_sends/i.test(text)) {
        persistedObligation = params[8] ? JSON.parse(params[8]).luna_supervisor_event_obligations[0] : null;
        return { rows: [{
          id: '33333333-3333-4333-8333-333333333334', client_slug: 'wolfhouse-somo',
          channel: 'whatsapp', to_phone: '+346****0000', idempotency_key: 'gate-block-1',
          send_kind: 'ask_missing_field', source: 'luna', message_text: 'question', status: 'blocked',
          blocked_reasons: JSON.parse(params[7]), provider_message_id: null,
          provider_response: params[8] ? JSON.parse(params[8]) : null,
          created_at: updatedAt, sent_at: null, updated_at: updatedAt,
        }] };
      }
      if (/FROM clients c[\s\S]*JOIN conversations conv/i.test(text)) {
        return { rows: [{ client_id: '11111111-1111-4111-8111-111111111111',
          conversation_id: '22222222-2222-4222-8222-222222222222' }] };
      }
      if (/INSERT INTO supervisor_events/i.test(text)) throw new Error('capture unavailable');
      if (/UPDATE guest_message_sends/i.test(text)) return { rows: [] };
      throw new Error(`unexpected gate-block SQL: ${text}`);
    },
  };
  const out = await evaluateGuestReplySendRouteWithPause({
    client_slug: 'wolfhouse-somo', conversation_id: '22222222-2222-4222-8222-222222222222',
    to: '+346****0000', idempotency_key: 'gate-block-1', suggested_reply: 'question',
    send_kind: 'ask_missing_field',
  }, { pg, env: { ...STAGING_ENV, LUNA_AUTO_SEND_ENABLED: 'false' } });
  assert.ok(persistedObligation && persistedObligation.row_id && persistedObligation.revision,
    'gate-block occurrence is durable before supervisor capture');
  assert.equal(out.result.supervisor_event_capture.captures[0].error, 'supervisor_event_capture_failed');
}

async function verifyAsyncFailedDeliveryEmission() {
  const revision = new Date('2026-11-01T23:20:00.000Z');
  const events = [];
  let sourcePersisted = false;
  const pg = {
    async connect() { throw new Error('borrowed PoolClient must not reconnect'); },
    release() { throw new Error('borrowed PoolClient must not release'); },
    async query(sql, params) {
      const text = String(sql);
      if (/^SAVEPOINT /i.test(text)) throw new Error('outside transaction');
      if (/WITH target AS[\s\S]*UPDATE guest_message_sends/i.test(text)) {
        sourcePersisted = true;
        const obligation = {
          ...JSON.parse(params[2]),
          cause_incident_id: '44444444-4444-4444-8444-444444444444',
        };
        return { rows: [{ id: 'async-send-1', client_slug: 'wolfhouse-somo',
          to_phone: '+346****0000', send_kind: 'confirmation', updated_at: revision,
          provider_response: {
            delivery_status: 'failed', booking_id: 'booking-async-1',
            booking_code: 'WH-ASYNC',
            cause_incident_id: '44444444-4444-4444-8444-444444444444',
            conversation_id: '22222222-2222-4222-8222-222222222222',
            luna_supervisor_event_obligations: [obligation],
          }, idempotency_key: 'supervisor-send-1', source: 'staff_inbox_supervisor' }] };
      }
      if (/FROM guest_message_sends[\s\S]*delivery_status/i.test(text)) {
        return { rows: [{ id: 'async-send-1', client_slug: 'wolfhouse-somo',
          to_phone: '+346****0000', send_kind: 'confirmation', updated_at: revision,
          provider_response: { delivery_status: 'failed' } }] };
      }
      if (/FROM clients c[\s\S]*JOIN conversations conv/i.test(text)) {
        return { rows: [{ client_id: '11111111-1111-4111-8111-111111111111',
          conversation_id: '22222222-2222-4222-8222-222222222222' }] };
      }
      if (/INSERT INTO supervisor_events/i.test(text)) {
        if (events.length) return { rows: [] };
        const row = { source_key: params[7], kind: params[4], reason: params[5],
          booking_id: params[2], booking_code: params[3], cause_incident_id: params[8] };
        events.push(row);
        return { rows: [row] };
      }
      if (/SELECT \* FROM supervisor_events WHERE source_key/i.test(text)) {
        return { rows: events.filter((row) => row.source_key === params[0]) };
      }
      throw new Error(`unexpected async-delivery SQL: ${text}`);
    },
  };
  const first = await captureFailedWhatsAppDeliveryStatus(pg,
    { provider_message_id: 'wamid.failed-1', client_slug: 'wolfhouse-somo',
      phone_number_id: 'wh-phone-id', callback_revision: revision.toISOString() }, { env: STAGING_ENV });
  const retry = await captureFailedWhatsAppDeliveryStatus(pg,
    { provider_message_id: 'wamid.failed-1', client_slug: 'wolfhouse-somo',
      phone_number_id: 'wh-phone-id', callback_revision: revision.toISOString() }, { env: STAGING_ENV });
  assert.equal(first.inserted, true);
  assert.equal(retry.inserted, false);
  assert.equal(events.length, 1);
  assert.match(events[0].reason, /provider_delivery_failed/);
  assert.match(events[0].source_key, /wa:wamid\.failed-1.*2026-11-01T23:20:00.000Z/);
  assert.equal(events[0].booking_id, 'booking-async-1');
  assert.equal(events[0].booking_code, 'WH-ASYNC');
  assert.equal(events[0].cause_incident_id, '44444444-4444-4444-8444-444444444444',
    'failed callback inherits the trusted cause from its matched send');
  assert.equal(sourcePersisted, true);
}

async function verifyUnmatchedCallbackDurabilityAndScope() {
  let writes = 0;
  const pg = {
    async query(sql) {
      const text = String(sql);
      if (/WITH target AS[\s\S]*UPDATE guest_message_sends/i.test(text)) {
        writes += 1;
        return { rows: [] };
      }
      if (/INSERT INTO guest_message_sends/i.test(text)) {
        writes += 1;
        return { rows: [] };
      }
      throw new Error(`unexpected unmatched SQL: ${text}`);
    },
  };
  const pending = await captureFailedWhatsAppDeliveryStatus(pg, {
    provider_message_id: 'wamid.early', client_slug: 'wolfhouse-somo',
    recipient_phone: '+34600000000', callback_revision: '1700000000',
    phone_number_id: 'wh-phone-id',
  }, { env: STAGING_ENV });
  assert.equal(pending.pending, true);
  assert.equal(writes, 2, 'unmatched callback persists retry evidence');
  const before = writes;
  const skipped = await captureFailedWhatsAppDeliveryStatus(pg, {
    provider_message_id: 'wamid.offscope', client_slug: 'sunset',
  }, { env: STAGING_ENV });
  assert.equal(skipped.skipped, 'outside_france_wolfhouse_staging');
  assert.equal(writes, before, 'scope rejection happens before source writes');
}

async function main() {
  assert.equal(isFranceWolfhouseStaging('wolfhouse-somo', STAGING_ENV), true);
  assert.equal(isFranceWolfhouseStaging('wolfhouse-somo', {
    NODE_ENV: 'staging', STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo',
  }), false, 'generic Wolfhouse staging cannot claim France identity');
  assert.equal(isFranceWolfhouseStaging('sunset', STAGING_ENV), false);
  assert.equal(isFranceWolfhouseStaging('wolfhouse-somo', { ...STAGING_ENV, NODE_ENV: 'production' }), false);
  assert.equal(isFranceWolfhouseStaging('wolfhouse-somo', {
    ...STAGING_ENV, WOLFHOUSE_DATABASE_URL: 'postgres://prod-host/wolfhouse_prod',
  }), false, 'any production signal wins');

  const failed = buildLunaSupervisorEvent({
    kind: 'luna_send_failed',
    client_slug: 'wolfhouse-somo',
    row_id: '33333333-3333-4333-8333-333333333333',
    revision: '2026-11-01T22:50:00.000Z',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    send_kind: 'confirmation',
    blocked_reasons: ['whatsapp_send_failed'],
    provider_error: 'Meta rejected destination token=secret',
    booking_code: 'WH-42',
    cause_incident_id: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(failed.obligation, 'confirmation');
  assert.equal(failed.booking_code, 'WH-42');
  assert.equal(failed.cause_incident_id, '44444444-4444-4444-8444-444444444444');
  assert.match(failed.source_key, /france-wolfhouse-staging:luna:luna_send_failed:33333333.*2026-11-01T22:50:00.000Z/);
  assert.match(failed.reason, /whatsapp_send_failed/);
  assert.doesNotMatch(failed.reason, /secret/, 'provider detail is not copied into the event reason');
  const sanitizedHandoff = buildLunaSupervisorEvent({
    kind: 'luna_needs_human', row_id: 'handoff-1', revision: '1',
    reason: 'call +34 612 345 678 at https://private.example token=secret',
  });
  assert.doesNotMatch(sanitizedHandoff.reason, /612|private\.example|secret/);

  const pg = memoryPg();
  const first = await emitLunaSupervisorEvent(pg, {
    kind: 'luna_send_failed', client_slug: 'wolfhouse-somo',
    row_id: '33333333-3333-4333-8333-333333333333', revision: '7',
    guest_phone: '+34600000000', send_kind: 'ask_missing_field',
    blocked_reasons: ['gate_bot_paused'], booking_code: 'WH-43',
  }, { env: STAGING_ENV });
  const duplicate = await emitLunaSupervisorEvent(pg, {
    kind: 'luna_send_failed', client_slug: 'wolfhouse-somo',
    row_id: '33333333-3333-4333-8333-333333333333', revision: '7',
    guest_phone: '+34600000000', send_kind: 'ask_missing_field',
    blocked_reasons: ['gate_bot_paused'], booking_code: 'WH-43',
  }, { env: STAGING_ENV });
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false, 'same source revision dedupes');
  assert.equal(pg.events[0].obligation, 'handoff');

  const nextRevision = await emitLunaSupervisorEvent(pg, {
    kind: 'luna_needs_human', client_slug: 'wolfhouse-somo',
    row_id: '55555555-5555-4555-8555-555555555555', revision: '2',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    reason: 'paid booking change', booking_code: 'WH-44',
    metadata: { needs_human_transition_id: '55555555-5555-4555-8555-555555555555' },
  }, { env: STAGING_ENV });
  assert.equal(nextRevision.inserted, true);
  assert.equal(pg.events[1].obligation, 'handoff');
  assert.equal(pg.events[1].metadata.needs_human_transition_id, '55555555-5555-4555-8555-555555555555');

  const offScope = await emitLunaSupervisorEvent(pg, {
    kind: 'luna_send_failed', client_slug: 'wolfhouse-somo', row_id: 'x', revision: '1',
  }, { env: { ...STAGING_ENV, NODE_ENV: 'production' } });
  assert.deepEqual(offScope, { inserted: false, skipped: 'outside_france_wolfhouse_staging' });

  const sendSource = fs.readFileSync(path.join(__dirname, 'lib/luna-guest-reply-send-route.js'), 'utf8');
  assert.match(sendSource, /emitLunaSupervisorEvent/);
  assert.match(sendSource, /auditRow\.updated_at/);
  assert.match(sendSource, /context\.incident_id/);
  assert.match(sendSource, /'cause_incident_id', \$6::text, 'conversation_id', \$7::text/,
    'matched sends retain trusted cause and conversation for later provider callbacks');
  assert.match(sendSource,
    /jsonb_array_length\([\s\S]*guest_message_sends\.provider_response[\s\S]*luna_supervisor_event_obligations[\s\S]*THEN guest_message_sends\.provider_response[\s\S]*ELSE[\s\S]*COALESCE\(EXCLUDED\.provider_response/,
    'gate retry preserves the first unacked obligation instead of replacing its source key');
  const inboundSource = fs.readFileSync(path.join(__dirname, 'lib/luna-meta-whatsapp-inbound-process.js'), 'utf8');
  assert.doesNotMatch(inboundSource,
    /capture\.error === 'failed_delivery_source_persist_failed'[\s\S]{0,240}throw err/,
    'failed-status persistence is fail-soft and cannot stop inbound processing');
  const handoffSource = fs.readFileSync(path.join(__dirname, 'lib/luna-guest-handoff-persist.js'), 'utf8');
  assert.match(handoffSource, /emitLunaSupervisorEvent/);
  assert.match(handoffSource, /needs_human_transition_id/);
  assert.match(handoffSource, /supervisor_event_capture/);
  assert.match(handoffSource, /luna_supervisor_event_obligations/);
  assert.match(handoffSource, /const obligationCandidates = \[/);
  assert.match(handoffSource, /legacyObligation/);
  assert.match(handoffSource, /-> 'luna_supervisor_event_obligation' ->> 'row_id' = \$3/);
  assert.doesNotMatch(handoffSource, /COALESCE\(conv\.metadata, '\{\}'::jsonb\) - 'luna_supervisor_event_obligation',/);
  assert.match(handoffSource, /Exact source-key dedupe makes every retained obligation safe to retry/);
  assert.match(handoffSource, /IS DISTINCT FROM \$3::text/);
  assert.match(handoffSource, /'needs_human_transition_id', CASE WHEN conv\.needs_human IS NOT TRUE/);
  assert.match(handoffSource, /obligation\.metadata/);
  assert.doesNotMatch(handoffSource, /handoff_occurrence_id/);

  await verifyAmbiguousPhoneScopeDoesNotPickNewestConversation();
  await verifyCaptureRollbackIsFailSoft();
  await verifySendRouteFailureEmission();
  await verifyGateBlockPersistsOccurrenceBeforeCapture();
  await verifyAsyncFailedDeliveryEmission();
  await verifyUnmatchedCallbackDurabilityAndScope();
  console.log('ok Luna emits revision-keyed supervisor failures and handoffs');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
