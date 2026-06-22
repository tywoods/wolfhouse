'use strict';

/**
 * Sunset staging QA fixtures for school-scoped conversations/customers.
 * Creates tagged rows via guest-inbound-review-dry-run (no outbound send).
 */

const crypto = require('crypto');
const {
  DEFAULT_SUNSET_LOCATION_ID,
  SUNSET_LOCATIONS,
} = require('./sunset-school-locations');

const DEFAULT_BASE = process.env.SUNSET_STAGING_BASE_URL || 'https://sunset-staging.lunafrontdesk.com';
const SUNSET_CLIENT_SLUG = 'sunset';

const PLACEHOLDER_RECEIVING = {
  'sunset-somo': '+340000000001',
  'sunset-sardinero': '+340000000002',
};

function resolveSchoolDisplayName(locationId) {
  const loc = SUNSET_LOCATIONS.find((l) => l.id === locationId);
  return loc ? loc.displayName : 'Sunset';
}

function createFixtureRunId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix || 'qa-conv'}-${stamp}-${rand}`;
}

function receivingWhatsappForLocation(locationId, env) {
  const e = env || process.env;
  const id = locationId === 'sunset-sardinero' ? 'sunset-sardinero' : 'sunset-somo';
  if (id === 'sunset-sardinero') {
    return trimStr(e.SUNSET_SARDINERO_WHATSAPP_NUMBER) || PLACEHOLDER_RECEIVING['sunset-sardinero'];
  }
  return trimStr(e.SUNSET_SOMO_WHATSAPP_NUMBER) || PLACEHOLDER_RECEIVING['sunset-somo'];
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function uniqueFixturePhone(locationId, runId) {
  const n = crypto.createHash('sha256').update(`${runId}:${locationId}`).digest('hex').slice(0, 7);
  return `+34698${n}`.slice(0, 16);
}

function buildFixtureConversationMetadata(locationId, runId) {
  return {
    location_id: locationId,
    qa_fixture: true,
    qa_fixture_run_id: runId,
    qa_fixture_kind: 'school_conversation',
  };
}

async function createFixtureConversation(page, options) {
  const opts = options || {};
  const locationId = opts.locationId === 'sunset-sardinero' ? 'sunset-sardinero' : DEFAULT_SUNSET_LOCATION_ID;
  const runId = opts.runId || createFixtureRunId('qa-conv');
  const baseUrl = opts.baseUrl || DEFAULT_BASE;
  const guestPhone = opts.guestPhone || uniqueFixturePhone(locationId, runId);
  const receivingWhatsapp = receivingWhatsappForLocation(locationId, opts.env);
  const inboundMessageId = `qa-fixture-${runId}-${locationId}`;

  const payload = {
    client_slug: SUNSET_CLIENT_SLUG,
    channel: 'whatsapp',
    guest_phone: guestPhone,
    message_text: opts.messageText || `Sunset QA fixture ${runId} (${locationId})`,
    contact_name: opts.contactName || `QA ${resolveSchoolDisplayName(locationId)}`,
    guest_name: opts.guestName || `QA ${resolveSchoolDisplayName(locationId)}`,
    inbound_message_id: inboundMessageId,
    receiving_whatsapp_number: receivingWhatsapp,
    conversation_metadata: buildFixtureConversationMetadata(locationId, runId),
  };

  const res = await page.evaluate(async ({ body, base }) => {
    const r = await fetch(`${base}/staff/bot/guest-inbound-review-dry-run`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }, { body: payload, base: baseUrl });

  const conversationId = res.json && (
    res.json.conversation_id
    || (res.json.body && res.json.body.conversation_id)
  );
  const fixture = {
    runId,
    locationId,
    guestPhone,
    conversationId: conversationId || null,
    inboundMessageId,
    schoolDisplayName: resolveSchoolDisplayName(locationId),
    metadata: buildFixtureConversationMetadata(locationId, runId),
    createStatus: res.status,
    sendsWhatsapp: res.json && res.json.sends_whatsapp,
  };

  return { res, fixture };
}

async function fetchInbox(page, locationId, baseUrl = DEFAULT_BASE) {
  return page.evaluate(async ({ location, base }) => {
    const r = await fetch(`${base}/staff/conversations?client=sunset&location=${encodeURIComponent(location)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { location: locationId, base: baseUrl });
}

async function fetchConversationDetail(page, conversationId, locationId, baseUrl = DEFAULT_BASE) {
  return page.evaluate(async ({ id, location, base }) => {
    const r = await fetch(`${base}/staff/conversations/${encodeURIComponent(id)}?client=sunset&location=${encodeURIComponent(location)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { id: conversationId, location: locationId, base: baseUrl });
}

async function deleteFixtureConversation(page, fixture, baseUrl = DEFAULT_BASE) {
  if (!fixture || !fixture.conversationId) {
    return { ok: false, skipped: true, reason: 'missing_conversation_id' };
  }
  return page.evaluate(async ({ id, runId, base }) => {
    const r = await fetch(`${base}/staff/conversations/${encodeURIComponent(id)}?client=sunset`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    return {
      status: r.status,
      json: await r.json().catch(() => ({})),
      conversation_id: id,
      qa_fixture_run_id: runId,
    };
  }, { id: fixture.conversationId, runId: fixture.runId, base: baseUrl });
}

async function teardownFixtureConversations(page, fixtures, baseUrl = DEFAULT_BASE) {
  const results = [];
  for (const fixture of fixtures || []) {
    try {
      results.push(await deleteFixtureConversation(page, fixture, baseUrl));
    } catch (err) {
      results.push({ ok: false, conversation_id: fixture && fixture.conversationId, error: err.message });
    }
  }
  return results;
}

/**
 * Run fn with fixture cleanup guaranteed in finally.
 */
async function withSunsetConversationFixtures(page, fn, options) {
  const opts = options || {};
  const runId = opts.runId || createFixtureRunId('qa-conv');
  const baseUrl = opts.baseUrl || DEFAULT_BASE;
  const fixtures = [];
  try {
    return await fn({
      runId,
      fixtures,
      createFixtureConversation: (locationId, extra) => createFixtureConversation(page, {
        locationId,
        runId,
        baseUrl,
        env: opts.env,
        ...(extra || {}),
      }).then((out) => {
        fixtures.push(out.fixture);
        return out;
      }),
      fetchInbox: (locationId) => fetchInbox(page, locationId, baseUrl),
      fetchConversationDetail: (conversationId, locationId) => fetchConversationDetail(page, conversationId, locationId, baseUrl),
      resolveSchoolDisplayName,
    });
  } finally {
    await teardownFixtureConversations(page, fixtures, baseUrl);
  }
}

module.exports = {
  DEFAULT_BASE,
  SUNSET_CLIENT_SLUG,
  PLACEHOLDER_RECEIVING,
  createFixtureRunId,
  resolveSchoolDisplayName,
  buildFixtureConversationMetadata,
  uniqueFixturePhone,
  createFixtureConversation,
  fetchInbox,
  fetchConversationDetail,
  deleteFixtureConversation,
  teardownFixtureConversations,
  withSunsetConversationFixtures,
};
