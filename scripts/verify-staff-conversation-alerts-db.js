'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const {
  ensureNotificationTables,
  reserveStaffAlertAttempt,
} = require('./lib/staff-whatsapp-notifications');

const rawUrl = process.env.STAFF_ALERT_TEST_DATABASE_URL;
if (!rawUrl) throw new Error('STAFF_ALERT_TEST_DATABASE_URL is required; no ambient database fallback');
const parsed = new URL(rawUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  || !/^guest_alerts_test(?:$|_)/.test(parsed.pathname.replace(/^\//, ''))) {
  throw new Error('refusing non-local or non-test PostgreSQL target');
}

const schema = `guest_alerts_${crypto.randomBytes(6).toString('hex')}`;
const pool = new Pool({ connectionString: rawUrl, max: 8, options: `-c search_path=${schema},public` });
let tests = 0;
function pass(label) { tests += 1; console.log(`PASS ${label}`); }

function request(overrides = {}) {
  return {
    authorization_id: 'proof-authorization-a',
    authorization_scope: {
      deployment: 'staging', sender_phone_number_id: 'sender-a', client_slug: 'wolfhouse-somo',
      location_id: null, staff_number_id: '11111111-1111-4111-8111-111111111111',
      recipient_phone: '+' + '34900000001', directory_revision: '2026-09-26T18:00:00.000Z',
      approved_guest_phone: '+' + '34900000002', alert_types: ['new_conversation', 'human_needed'],
    },
    max_attempts: 2,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    client_slug: 'wolfhouse-somo', location_id: null,
    conversation_id: '22222222-2222-4222-8222-222222222222',
    notification_type: 'new_conversation', handoff_event_key: '33333333-3333-4333-8333-333333333333',
    staff_number_id: '11111111-1111-4111-8111-111111111111',
    recipient_phone: '+' + '34900000001', recipient_name: 'Proof',
    directory_revision: '2026-09-26T18:00:00.000Z', message_preview: 'proof',
    ...overrides,
  };
}

async function main() {
  const admin = new Pool({ connectionString: rawUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  try {
    await ensureNotificationTables(pool);

    const same = request();
    await pool.query(`INSERT INTO client_notification_events
      (client_slug,location_id,conversation_id,notification_type,handoff_event_key,recipient_phone,recipient_name,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'dry_run')`, [same.client_slug, same.location_id,
      same.conversation_id, same.notification_type, same.handoff_event_key, same.recipient_phone, same.recipient_name]);
    const identical = await Promise.all([
      reserveStaffAlertAttempt(pool, same),
      reserveStaffAlertAttempt(pool, same),
    ]);
    assert.equal(identical.filter((x) => x.reserved).length, 1);
    assert.equal(identical.filter((x) => x.duplicate).length, 1);
    const identicalState = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM client_notification_events WHERE authorization_id=$1) AS events,
      spent_total, spent_new_conversation FROM staff_alert_authorizations WHERE authorization_id=$1`,
    [same.authorization_id]);
    assert.deepEqual(identicalState.rows[0], { events: 1, spent_total: 1, spent_new_conversation: 1 });
    const dryAudit = await pool.query(`SELECT COUNT(*)::int AS count FROM client_notification_events
      WHERE authorization_id IS NULL AND status='dry_run'`);
    assert.equal(dryAudit.rows[0].count, 1);
    pass('prior dry-run audit does not block identical live-event race');

    const human = request({
      notification_type: 'human_needed',
      handoff_event_key: '44444444-4444-4444-8444-444444444444',
    });
    const different = await Promise.all([
      reserveStaffAlertAttempt(pool, human),
      reserveStaffAlertAttempt(pool, request({
        notification_type: 'human_needed',
        conversation_id: '55555555-5555-4555-8555-555555555555',
        handoff_event_key: '66666666-6666-4666-8666-666666666666',
      })),
    ]);
    assert.equal(different.filter((x) => x.reserved).length, 1);
    assert.equal(different.filter((x) => x.reason === 'canary_budget_exhausted').length, 1);
    const contentionState = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM client_notification_events WHERE authorization_id=$1) AS events,
      spent_total, spent_human_needed FROM staff_alert_authorizations WHERE authorization_id=$1`,
    [same.authorization_id]);
    assert.deepEqual(contentionState.rows[0], { events: 2, spent_total: 2, spent_human_needed: 1 });
    pass('different-event one-slot contention honors remaining total budget');

    const restartedPool = new Pool({ connectionString: rawUrl, max: 2, options: `-c search_path=${schema},public` });
    const afterRestart = await reserveStaffAlertAttempt(restartedPool, request({
      notification_type: 'human_needed',
      handoff_event_key: '77777777-7777-4777-8777-777777777777',
    }));
    await restartedPool.end();
    assert.equal(afterRestart.reserved, false);
    assert.equal(afterRestart.reason, 'canary_budget_exhausted');
    pass('restart does not restore spent budget');

    const expired = await reserveStaffAlertAttempt(pool, request({
      authorization_id: 'proof-expired',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      handoff_event_key: '88888888-8888-4888-8888-888888888888',
    }));
    assert.equal(expired.reserved, false);
    assert.equal(expired.reason, 'canary_expired');
    const expiredState = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM client_notification_events WHERE authorization_id=$1) AS events,
      (SELECT COUNT(*)::int FROM staff_alert_authorizations WHERE authorization_id=$1) AS authorizations`,
    ['proof-expired']);
    assert.deepEqual(expiredState.rows[0], { events: 0, authorizations: 0 });
    pass('database wall clock rejects expired authorization');

    const perType = await reserveStaffAlertAttempt(pool, request({
      authorization_id: 'proof-per-type', max_attempts: 2,
      handoff_event_key: '99999999-9999-4999-8999-999999999991',
    }));
    assert.equal(perType.reserved, true);
    const sameTypeAgain = await reserveStaffAlertAttempt(pool, request({
      authorization_id: 'proof-per-type', max_attempts: 2,
      conversation_id: '99999999-9999-4999-8999-999999999992',
      handoff_event_key: '99999999-9999-4999-8999-999999999993',
    }));
    assert.equal(sameTypeAgain.reserved, false);
    assert.equal(sameTypeAgain.reason, 'canary_type_budget_exhausted');
    const otherType = await reserveStaffAlertAttempt(pool, request({
      authorization_id: 'proof-per-type', max_attempts: 2,
      notification_type: 'human_needed',
      handoff_event_key: '99999999-9999-4999-8999-999999999994',
    }));
    assert.equal(otherType.reserved, true);
    const perTypeState = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM client_notification_events WHERE authorization_id=$1) AS events,
      spent_total, spent_new_conversation, spent_human_needed
      FROM staff_alert_authorizations WHERE authorization_id=$1`, ['proof-per-type']);
    assert.deepEqual(perTypeState.rows[0], {
      events: 2, spent_total: 2, spent_new_conversation: 1, spent_human_needed: 1,
    });
    pass('per-type cap preserves the other alert type slot');

    assert.ok(tests > 0);
    console.log(`staff conversation alerts DB: ${tests}/${tests} passed`);
  } finally {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await pool.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
