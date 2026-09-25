'use strict';

/**
 * Staff WhatsApp notification settings + dispatch verifier (no DB, no network).
 */

const fs = require('fs');
const path = require('path');
const {
  validateNotificationSettingsPayload,
  validateNotificationTypeConfig,
  buildNewConversationMessage,
  buildHumanNeededMessage,
  buildStaffInboxDeepLink,
  dispatchStaffWhatsAppNotifications,
  putNotificationSettings,
  getNotificationSettings,
  isStaffNotificationsEnabled,
  isStaffNotificationsDryRun,
  validateStaffAlertCanaryAuthorization,
  resolveActiveStaffAlertRecipient,
  resolveStoredConversationTruth,
  PHONE_RE,
} = require('./lib/staff-whatsapp-notifications');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
  }
}

function createMockPg(seed = {}) {
  const clients = new Set(seed.clients || ['wolfhouse-somo', 'sunset']);
  const directoryRows = Array.isArray(seed.directoryRows) ? seed.directoryRows : [];
  const conversationRows = Array.isArray(seed.conversationRows) ? seed.conversationRows : null;
  const settings = new Map();
  const events = [];

  function settingsKey(slug, loc, type) {
    return `${slug}::${loc || ''}::${type}`;
  }

  function eventKey(row) {
    return [
      row.client_slug,
      row.location_id || '',
      row.conversation_id || '',
      row.notification_type,
      row.handoff_event_key,
      row.recipient_phone,
    ].join('::');
  }

  return {
    events,
    async query(sql, params = []) {
      const q = String(sql);
      if (q.includes('FROM conversations conv') && q.includes('JOIN clients c')) {
        if (seed.conversationLookupError) throw new Error('fixture conversation lookup failure');
        const [clientSlug, conversationId] = params;
        const rows = conversationRows === null
          ? (clients.has(clientSlug) ? [{
            conversation_id: conversationId,
            client_slug: clientSlug,
            guest_phone: seed.defaultGuestPhone || ('+' + '34900000099'),
            guest_name: seed.defaultGuestName || 'Stored fixture guest',
            guest_id: null,
            customer_id: null,
            metadata: seed.defaultMetadata || {},
          }] : [])
          : conversationRows.filter((row) => row.client_slug === clientSlug && row.conversation_id === conversationId);
        return { rows, rowCount: rows.length };
      }
      if (q.includes('FROM wolfhouse_staff_whatsapp_numbers')) {
        const [clientSlug, staffNumberId] = params;
        const row = directoryRows.find((entry) => entry.client_slug === clientSlug
          && entry.staff_number_id === staffNumberId && entry.active !== false);
        return { rows: row ? [{
          id: row.staff_number_id,
          name: row.name || 'Fixture desk',
          phone: row.phone,
          updated_at: row.updated_at || '2026-09-25T11:24:00.000Z',
        }] : [] };
      }
      if (q.includes('FROM clients WHERE slug = $1')) {
        const slug = params[0];
        return { rows: clients.has(slug) ? [{ id: 'client-1' }] : [] };
      }
      if (/CREATE TABLE/i.test(q) || /CREATE UNIQUE INDEX/i.test(q) || /CREATE INDEX/i.test(q)) {
        return { rows: [] };
      }
      if (/FROM client_notification_settings/i.test(q) && /SELECT/i.test(q)) {
        const slug = params[0];
        const loc = params[1] || '';
        const rows = [];
        for (const [key, row] of settings.entries()) {
          const parts = key.split('::');
          if (parts[0] === slug && parts[1] === (loc || '')) {
            rows.push({
              notification_type: parts[2],
              enabled: row.enabled,
              recipients: row.recipients,
            });
          }
        }
        return { rows };
      }
      if (/UPDATE client_notification_settings/i.test(q)) {
        const slug = params[0];
        const loc = params[1];
        const type = params[2];
        const key = settingsKey(slug, loc, type);
        if (!settings.has(key)) return { rowCount: 0, rows: [] };
        settings.set(key, { enabled: params[3], recipients: JSON.parse(params[4]) });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO client_notification_settings/i.test(q)) {
        const key = settingsKey(params[0], params[1] || '', params[2]);
        settings.set(key, { enabled: params[3], recipients: JSON.parse(params[4]) });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO client_notification_events/i.test(q)) {
        const row = {
          client_slug: params[0],
          location_id: params[1],
          conversation_id: params[2],
          notification_type: params[3],
          handoff_event_key: params[4],
          recipient_phone: params[5],
          recipient_name: params[6],
          status: params[7],
          reason: params[8],
          message_preview: params[9],
          provider_message_id: params[10],
          error: params[11],
        };
        const ek = eventKey(row);
        if (events.some((e) => eventKey(e) === ek)) {
          return { rows: [] };
        }
        const id = `evt-${events.length + 1}`;
        events.push({ id, ...row });
        return { rows: [{ id, status: row.status }] };
      }
      if (/UPDATE client_notification_events/i.test(q)) {
        const id = params[0];
        const ev = events.find((e) => e.id === id);
        if (ev) {
          ev.status = params[1];
          ev.provider_message_id = params[2];
          ev.error = params[3];
        }
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
    seedSettings(slug, loc, type, cfg) {
      settings.set(settingsKey(slug, loc, type), cfg);
    },
  };
}

async function runAsyncTests() {
  console.log('\n── validation ──');
  ok('stored conversation truth resolver exported', typeof resolveStoredConversationTruth === 'function');
  const badPhone = validateNotificationTypeConfig({
    enabled: true,
    recipients: [{ name: 'Desk', phone: '+123', enabled: true }],
  }, 'new_conversation');
  ok('settings validation rejects invalid phones', badPhone.ok === false);

  const goodPhone = validateNotificationTypeConfig({
    enabled: true,
    recipients: [{ name: 'Desk', phone: '+34900000001', enabled: true }],
  }, 'new_conversation');
  ok('settings validation accepts E.164 phone', goodPhone.ok === true);
  ok('E.164 regex matches fixture phone', PHONE_RE.test('+34900000001'));
  const directoryRecipient = validateNotificationTypeConfig({
    enabled: true,
    recipients: [{ staff_number_id: '11111111-1111-4111-8111-111111111111', name: 'Desk', phone: '+34900000001', enabled: true }],
  }, 'new_conversation');
  ok('settings preserve directory recipient ID', directoryRecipient.ok === true
    && directoryRecipient.recipients[0].staff_number_id === '11111111-1111-4111-8111-111111111111');
  const idOnlyDirectoryRecipient = validateNotificationTypeConfig({
    enabled: true,
    recipients: [{ staff_number_id: '11111111-1111-4111-8111-111111111111', enabled: true }],
  }, 'new_conversation');
  ok('settings accept an enabled directory ID without copied phone data', idOnlyDirectoryRecipient.ok === true
    && idOnlyDirectoryRecipient.recipients[0].staff_number_id === '11111111-1111-4111-8111-111111111111'
    && idOnlyDirectoryRecipient.recipients[0].phone === null);
  const directoryPg = {
    async query(sql, params) {
      if (/FROM wolfhouse_staff_whatsapp_numbers/.test(String(sql))
        && params[0] === 'wolfhouse-somo' && params[1] === '11111111-1111-4111-8111-111111111111') {
        return { rows: [{ id: params[1], phone: '+34900000001', display_name: 'Desk', active: true, updated_at: '2026-09-25T11:24:00.000Z' }] };
      }
      return { rows: [] };
    },
  };
  const activeDirectoryRecipient = await resolveActiveStaffAlertRecipient(directoryPg, 'wolfhouse-somo', '11111111-1111-4111-8111-111111111111');
  ok('active recipient resolution is tenant-bound and returns the current phone version', activeDirectoryRecipient.ok === true
    && activeDirectoryRecipient.phone === '+34900000001'
    && activeDirectoryRecipient.phone_version === '2026-09-25T11:24:00.000Z');
  const foreignDirectoryRecipient = await resolveActiveStaffAlertRecipient(directoryPg, 'sunset', '11111111-1111-4111-8111-111111111111');
  ok('foreign recipient ID is refused', foreignDirectoryRecipient.ok === false && foreignDirectoryRecipient.reason === 'recipient_not_active');

  const pgA = createMockPg({ clients: ['wolfhouse-somo', 'sunset'] });
  await putNotificationSettings(pgA, {
    clientSlug: 'wolfhouse-somo',
    locationId: null,
    settings: {
      new_conversation: { enabled: true, recipients: [{ name: 'A', phone: '+34900000001', enabled: true }] },
      human_needed: { enabled: false, recipients: [] },
    },
  });
  await putNotificationSettings(pgA, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    settings: {
      new_conversation: { enabled: true, recipients: [{ name: 'B', phone: '+34900000002', enabled: true }] },
      human_needed: { enabled: false, recipients: [] },
    },
  });
  const wolfSettings = await getNotificationSettings(pgA, { clientSlug: 'wolfhouse-somo', locationId: null });
  const sunsetSettings = await getNotificationSettings(pgA, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('settings are client-scoped (wolfhouse recipient isolated)', wolfSettings.new_conversation.recipients[0].phone === '+34900000001');
  ok('settings are client-scoped (sunset recipient isolated)', sunsetSettings.new_conversation.recipients[0].phone === '+34900000002');

  console.log('\n── message payloads ──');
  const env = {
    STAFF_PORTAL_PUBLIC_BASE_URL: 'https://staff.example.test',
    STAFF_WHATSAPP_NOTIFICATIONS_ENABLED: 'true',
    STAFF_WHATSAPP_NOTIFICATIONS_DRY_RUN: 'true',
  };
  const convId = '11111111-1111-4111-8111-111111111111';
  const newMsg = buildNewConversationMessage({
    guest_phone: '+34900000099',
    guest_name: 'Alex',
    client_slug: 'wolfhouse-somo',
    conversation_id: convId,
    env,
  });
  ok('new conversation payload includes guest phone', newMsg.includes('+34900000099'));
  ok('new conversation payload includes guest name', newMsg.includes('Alex'));
  ok('new conversation payload includes client display', /Wolfhouse/i.test(newMsg));
  ok('new conversation payload includes inbox link', newMsg.includes(`/staff/inbox?client=wolfhouse-somo&conversation=${convId}`));

  const humanMsg = buildHumanNeededMessage({
    guest_phone: '+34900000099',
    guest_name: 'Alex',
    client_slug: 'wolfhouse-somo',
    conversation_id: convId,
    reason: 'payment question',
    env,
  });
  ok('human-needed payload includes reason', humanMsg.includes('payment question'));
  ok('human-needed payload includes inbox link', humanMsg.includes('conversation=' + convId));

  const relativeLink = buildStaffInboxDeepLink('wolfhouse-somo', convId, null, {});
  ok('inbox link falls back to relative path without base URL', relativeLink.startsWith('/staff/inbox?'));

  console.log('\n── dispatch / dedupe / gates ──');
  const missingInitialIdentity = await dispatchStaffWhatsAppNotifications(createMockPg({ clients: ['wolfhouse-somo'] }), env, {
    client_slug: 'wolfhouse-somo', conversation_id: convId, notification_type: 'new_conversation',
  });
  ok('new conversation dispatch rejects missing durable event identity',
    missingInitialIdentity.skipped === true && missingInitialIdentity.reason === 'event_identity_missing');
  const missingHandoffIdentity = await dispatchStaffWhatsAppNotifications(createMockPg({ clients: ['wolfhouse-somo'] }), env, {
    client_slug: 'wolfhouse-somo', conversation_id: convId, notification_type: 'human_needed',
  });
  ok('Needs Human dispatch rejects missing durable event identity',
    missingHandoffIdentity.skipped === true && missingHandoffIdentity.reason === 'event_identity_missing');
  ok('event identity helper has no process-clock fallback',
    !fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-whatsapp-notifications.js'), 'utf8').includes('handoff:${Date.now()}'));
  let metaCalls = 0;
  const mockSend = {
    async sendMessage() {
      metaCalls += 1;
      return { success: true, whatsapp_message_id: 'wamid.TEST' };
    },
  };

  const pgB = createMockPg({ clients: ['wolfhouse-somo'] });
  await putNotificationSettings(pgB, {
    clientSlug: 'wolfhouse-somo',
    locationId: null,
    settings: {
      new_conversation: {
        enabled: true,
        recipients: [{ name: 'Desk', phone: '+34900000003', enabled: true }],
      },
      human_needed: { enabled: false, recipients: [] },
    },
  });

  const first = await dispatchStaffWhatsAppNotifications(pgB, env, {
    client_slug: 'wolfhouse-somo',
    conversation_id: convId,
    notification_type: 'new_conversation',
    handoff_event_key: convId,
    guest_phone: '+34900000099',
    guest_name: 'Alex',
  }, mockSend);
  const second = await dispatchStaffWhatsAppNotifications(pgB, env, {
    client_slug: 'wolfhouse-somo',
    conversation_id: convId,
    notification_type: 'new_conversation',
    handoff_event_key: convId,
    guest_phone: '+34900000099',
    guest_name: 'Alex',
  }, mockSend);

  ok('dry-run does not call Meta', metaCalls === 0);
  ok('dry-run records audit row', pgB.events.some((e) => e.status === 'dry_run'));
  ok('dry-run returns message payload shape', !!(first.results && first.results[0] && first.results[0].message));

  const liveDirectoryPg = createMockPg({
    clients: ['wolfhouse-somo'],
    directoryRows: [{
      client_slug: 'wolfhouse-somo', staff_number_id: '11111111-1111-4111-8111-111111111111',
      phone: '+' + '34900000003', updated_at: '2026-09-25T11:24:00.000Z',
    }],
  });
  await putNotificationSettings(liveDirectoryPg, {
    clientSlug: 'wolfhouse-somo', locationId: null,
    settings: {
      new_conversation: { enabled: true, recipients: [{
        staff_number_id: '11111111-1111-4111-8111-111111111111', enabled: true,
      }] },
      human_needed: { enabled: false, recipients: [] },
    },
  });
  const liveDirectoryAuth = {
    authorization_id: 'ty-canary-001', deployment: 'sunset-staging', sender_phone_number_id: 'sender-001',
    client_slug: 'wolfhouse-somo', location_id: null,
    staff_number_id: '11111111-1111-4111-8111-111111111111', recipient_phone: '+' + '34900000003',
    directory_revision: '2026-09-25T11:24:00.000Z', approved_guest_phone: '+' + '34900000099',
    alert_types: ['new_conversation'], expires_at: '2099-01-01T00:00:00.000Z', max_attempts: 2,
  };
  let liveDirectoryProviderCalls = 0;
  const liveDirectoryResult = await dispatchStaffWhatsAppNotifications(liveDirectoryPg, {
    STAFF_WHATSAPP_NOTIFICATIONS_ENABLED: 'true', STAFF_WHATSAPP_NOTIFICATIONS_DRY_RUN: 'false',
    STAFF_ALERT_CANARY_AUTHORIZATION: JSON['stringify'](liveDirectoryAuth),
    LUNA_DEPLOYMENT: 'sunset-staging', WHATSAPP_PHONE_NUMBER_ID: 'sender-001',
  }, {
    client_slug: 'wolfhouse-somo', conversation_id: '33333333-3333-4333-8333-333333333333',
    notification_type: 'new_conversation', handoff_event_key: '33333333-3333-4333-8333-333333333333', guest_phone: '+' + '34900000099', guest_name: 'Fixture guest',
  }, {
    async sendMessage() {
      liveDirectoryProviderCalls += 1;
      return { success: true, whatsapp_message_id: 'wamid.fixture' };
    },
  });
  ok('live dispatch resolves ID-only settings through the active tenant directory row',
    liveDirectoryProviderCalls === 1 && liveDirectoryResult.results[0] && liveDirectoryResult.results[0].status === 'sent');

  ok('dedupe prevents duplicate sends', !!(second.results[0] && second.results[0].status === 'duplicate'));

  const unknown = await dispatchStaffWhatsAppNotifications(pgB, env, {
    client_slug: 'unknown-client-slug',
    conversation_id: convId,
    notification_type: 'new_conversation',
    handoff_event_key: convId,
    guest_phone: '+34900000099',
  }, mockSend);
  ok('unknown/unresolved client sends no notification', unknown.skipped === true && unknown.reason === 'conversation_not_found');

  const missingTruth = await resolveStoredConversationTruth(createMockPg({ conversationRows: [] }), {
    client_slug: 'wolfhouse-somo', conversation_id: convId,
  });
  ok('stored truth fails closed when conversation is missing', missingTruth.ok === false
    && missingTruth.reason === 'conversation_not_found');
  const lookupFailureTruth = await resolveStoredConversationTruth(createMockPg({ conversationLookupError: true }), {
    client_slug: 'wolfhouse-somo', conversation_id: convId,
  });
  ok('stored truth fails closed on lookup error', lookupFailureTruth.ok === false
    && lookupFailureTruth.reason === 'conversation_lookup_failed');
  const syntheticTruth = await resolveStoredConversationTruth(createMockPg({
    defaultMetadata: { simulator_synthetic: true },
  }), { client_slug: 'wolfhouse-somo', conversation_id: convId });
  ok('stored synthetic provenance vetoes alerts', syntheticTruth.ok === false
    && syntheticTruth.reason === 'synthetic_conversation');
  const reservedTruth = await resolveStoredConversationTruth(createMockPg({ defaultGuestPhone: '+' + '999000000001' }), {
    client_slug: 'wolfhouse-somo', conversation_id: convId,
  });
  ok('reserved simulator guest identity vetoes alerts', reservedTruth.ok === false
    && reservedTruth.reason === 'synthetic_conversation');
  const malformedSunsetTruth = await resolveStoredConversationTruth(createMockPg({
    clients: ['sunset'], defaultMetadata: { location_id: 'sunset-unknown' },
  }), { client_slug: 'sunset', conversation_id: convId });
  ok('stored Sunset location must be canonical', malformedSunsetTruth.ok === false
    && malformedSunsetTruth.reason === 'conversation_location_invalid');
  const ordinaryTruth = await resolveStoredConversationTruth(createMockPg({
    defaultGuestPhone: '+' + '34900000099', defaultGuestName: 'Stored Name',
  }), { client_slug: 'wolfhouse-somo', conversation_id: convId });
  ok('stored ordinary conversation provides authoritative guest identity', ordinaryTruth.ok === true
    && ordinaryTruth.conversation.guest_phone === '+' + '34900000099'
    && ordinaryTruth.conversation.guest_name === 'Stored Name');

  ok('env gate defaults disabled', isStaffNotificationsEnabled({}) === false);
  ok('env gate dry-run defaults true', isStaffNotificationsDryRun({}) === true);

  console.log('\n── canary authority ──');
  const staffNumberId = '11111111-1111-4111-8111-111111111111';
  const staffPhone = '+' + '34900000003';
  const guestPhone = '+' + '34900000099';
  const directoryRevision = '2026-09-25T11:24:00.000Z';
  const authKey = ['STAFF', 'ALERT', 'CANARY', 'AUTHORIZATION'].join('_');
  const baseAuthorization = {
    authorization_id: 'ty-canary-001',
    deployment: 'sunset-staging',
    sender_phone_number_id: 'sender-001',
    client_slug: 'wolfhouse-somo',
    location_id: null,
    staff_number_id: staffNumberId,
    recipient_phone: staffPhone,
    directory_revision: directoryRevision,
    approved_guest_phone: guestPhone,
    alert_types: ['new_conversation', 'human_needed'],
    expires_at: '2099-01-01T00:00:00.000Z',
    max_attempts: 2,
  };
  const baseCanaryInput = {
    client_slug: 'wolfhouse-somo',
    location_id: null,
    staff_number_id: staffNumberId,
    phone: staffPhone,
    directory_revision: directoryRevision,
    guest_phone: guestPhone,
    notification_type: 'new_conversation',
  };
  function checkCanary(authPatch = {}, inputPatch = {}, envPatch = {}) {
    const checkEnv = {
      LUNA_DEPLOYMENT: 'sunset-staging',
      WHATSAPP_PHONE_NUMBER_ID: 'sender-001',
      ...envPatch,
    };
    checkEnv[authKey] = JSON.stringify({ ...baseAuthorization, ...authPatch });
    return validateStaffAlertCanaryAuthorization(checkEnv, { ...baseCanaryInput, ...inputPatch });
  }

  const approvedCanary = checkCanary();
  ok('canary authority requires exact recipient phone/revision/type and trusted identities', approvedCanary.ok === true);
  const missingRecipientIdCanary = checkCanary({ staff_number_id: '' }, { staff_number_id: '' });
  ok('canary authority rejects blank recipient IDs on both sides', missingRecipientIdCanary.ok === false
    && missingRecipientIdCanary.reason === 'canary_authorization_invalid');
  const missingVersionCanary = checkCanary({ directory_revision: '' }, { directory_revision: '' });
  ok('canary authority rejects blank directory revisions on both sides', missingVersionCanary.ok === false
    && missingVersionCanary.reason === 'canary_authorization_invalid');
  const malformedPhoneCanary = checkCanary({ recipient_phone: 'not-a-phone' }, { phone: 'also-not-a-phone' });
  ok('canary authority rejects malformed phones on both sides', malformedPhoneCanary.ok === false
    && malformedPhoneCanary.reason === 'canary_authorization_invalid');
  const missingTenantCanary = checkCanary({ client_slug: '' }, { client_slug: '' });
  ok('canary authority rejects blank tenants on both sides', missingTenantCanary.ok === false
    && missingTenantCanary.reason === 'canary_authorization_invalid');
  const wrongDeploymentCanary = checkCanary({ deployment: 'different-staging' });
  ok('canary authority binds approval to trusted deployment identity', wrongDeploymentCanary.ok === false
    && wrongDeploymentCanary.reason === 'canary_deployment_mismatch');
  const wrongSenderCanary = checkCanary({ sender_phone_number_id: 'sender-002' });
  ok('canary authority binds approval to trusted sender identity', wrongSenderCanary.ok === false
    && wrongSenderCanary.reason === 'canary_sender_mismatch');
  const wrongGuestCanary = checkCanary({}, { guest_phone: '+' + '34900000097' });
  ok('canary authority binds approval to the durable guest identity', wrongGuestCanary.ok === false
    && wrongGuestCanary.reason === 'canary_guest_mismatch');
  const blankLocationCanary = checkCanary({ location_id: '' }, { location_id: '' });
  ok('canary authority rejects blank locations instead of coercing them to null', blankLocationCanary.ok === false
    && blankLocationCanary.reason === 'canary_authorization_invalid');
  const unknownSunsetLocationCanary = checkCanary({ client_slug: 'sunset', location_id: 'sunset-unknown' }, {
    client_slug: 'sunset', location_id: 'sunset-unknown',
  });
  ok('canary authority rejects unknown Sunset locations', unknownSunsetLocationCanary.ok === false
    && unknownSunsetLocationCanary.reason === 'canary_authorization_invalid');
  const coercedTypeCanary = checkCanary({ alert_types: [123] }, { notification_type: '123' });
  ok('canary authority rejects non-string or unknown alert types', coercedTypeCanary.ok === false
    && coercedTypeCanary.reason === 'canary_authorization_invalid');
  const nonCanonicalExpiryCanary = checkCanary({ expires_at: '2099-01-01T00:00:00Z' });
  ok('canary authority rejects non-canonical expiry values', nonCanonicalExpiryCanary.ok === false
    && nonCanonicalExpiryCanary.reason === 'canary_authorization_invalid');
  const stringBudgetCanary = checkCanary({ max_attempts: '2' });
  ok('canary authority rejects coerced numeric budgets', stringBudgetCanary.ok === false
    && stringBudgetCanary.reason === 'canary_authorization_invalid');
  const stalePhoneCanary = checkCanary({}, { phone: '+' + '34900000098' });
  ok('changed phone denies the same recipient ID', stalePhoneCanary.ok === false
    && stalePhoneCanary.reason === 'canary_phone_mismatch');

  const pgLiveNoCanary = createMockPg({ clients: ['wolfhouse-somo'] });
  await putNotificationSettings(pgLiveNoCanary, {
    clientSlug: 'wolfhouse-somo', locationId: null,
    settings: {
      new_conversation: { enabled: true, recipients: [{ name: 'Fixture desk', phone: '+34900000003', enabled: true }] },
      human_needed: { enabled: false, recipients: [] },
    },
  });
  let liveProviderCalls = 0;
  const liveDenied = await dispatchStaffWhatsAppNotifications(pgLiveNoCanary, {
    STAFF_WHATSAPP_NOTIFICATIONS_ENABLED: 'true', STAFF_WHATSAPP_NOTIFICATIONS_DRY_RUN: 'false',
  }, {
    client_slug: 'wolfhouse-somo', conversation_id: '22222222-2222-4222-8222-222222222222',
    notification_type: 'new_conversation', handoff_event_key: '22222222-2222-4222-8222-222222222222', guest_phone: '+' + '34900000099', guest_name: 'Fixture guest',
  }, { async sendMessage(){ liveProviderCalls += 1; return { success: true, whatsapp_message_id: 'wamid.NEVER' }; } });
  ok('live dispatch without a canary authorization calls no provider', liveProviderCalls === 0 && liveDenied.results[0].status === 'skipped' && liveDenied.results[0].reason === 'canary_authorization_missing');

  console.log('\n── repo hygiene ──');
  const staffApi = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
  ok('staff API exposes notification settings route', staffApi.includes('/staff/notification-settings'));
  ok('staff API exposes Luna Staff notification UI card', staffApi.includes('cc-staff-notification-settings'));
  ok('notification card uses Guest Conversation Alerts title', staffApi.includes('>Guest Conversation Alerts</div>'));
  ok('old Staff WhatsApp Alerts card title removed', !staffApi.includes('>Staff WhatsApp Alerts</div>'));
  ok('notification card markup includes new conversation block', staffApi.includes('sns-new-enabled'));
  ok('notification card markup includes human needed block', staffApi.includes('sns-human-enabled'));
  ok('maybeLoadStaffNotificationSettings helper exists', staffApi.includes('function maybeLoadStaffNotificationSettings'));
  ok('staffNotificationSettingsApplyVisibility helper exists', staffApi.includes('function staffNotificationSettingsApplyVisibility'));
  ok('wireLunaStaffTabCards wires notification maybe-load', /function wireLunaStaffTabCards[\s\S]*maybeLoadStaffNotificationSettings/.test(staffApi));
  ok('Luna Staff tab switch uses wireLunaStaffTabCards', staffApi.includes("if (tab === 'ask-luna') wireLunaStaffTabCards();"));
  ok('Luna Staff tab click uses wireLunaStaffTabCards', staffApi.includes("if (target === 'ask-luna') wireLunaStaffTabCards();"));
  ok('applyOwnerInsightsGate does not hard-hide notification card', !/snsCard\) snsCard\.style\.display = 'none'/.test(staffApi));
  ok('applyOwnerInsightsGate defers notification load via maybeLoad', /applyOwnerInsightsGate[\s\S]*maybeLoadStaffNotificationSettings/.test(staffApi));
  ok('notification fetch soft-fail re-applies visibility', /staffNotificationSettingsApplyVisibility\(\);[\s\S]*staffNotificationShowMsg\('error'/.test(staffApi));
  ok('notification remove button uses safe quote concat', staffApi.includes("' + \"'\" + type + \"'\" +"));
  ok('notification remove button avoids broken template quotes', !staffApi.includes("RecipientRemove(\\'' + type"));
  ok('notification card has no global enable row', !staffApi.includes('Enable staff WhatsApp alerts') && !staffApi.includes('id="sns-global-enabled"'));
  ok('notification recipient row uses compact grid layout', staffApi.includes('sns-recipient-row'));
  ok('notification recipient row includes name placeholder', staffApi.includes('placeholder="Name"'));
  ok('notification recipient row includes phone placeholder', staffApi.includes('placeholder="+34600000000"'));
  ok('notification recipient row has no per-recipient enabled checkbox', !staffApi.includes('sns-recipient-enabled'));
  ok('notification recipient row includes remove button', /sns-recipient-remove[\s\S]*Remove/.test(staffApi));
  ok('notification empty state copy exists', staffApi.includes('No recipients yet. Add one staff member to receive these alerts.'));
  ok('notification section titles use new copy', staffApi.includes('New conversation alerts') && staffApi.includes('Human needed alerts'));
  ok('notification per-type status pill hooks exist', staffApi.includes('sns-new-pill') && staffApi.includes('sns-human-pill') && staffApi.includes('staffNotificationServerPillApply'));
  ok('notification type pill sync helper exists', staffApi.includes('function staffNotificationTypePillSync'));

  const forbiddenPatterns = [
    /WHATSAPP_ACCESS_TOKEN\s*=\s*['"][^'"]+['"]/,
    /META_WHATSAPP_ACCESS_TOKEN\s*=\s*['"][^'"]+['"]/,
  ];
  const libSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-whatsapp-notifications.js'), 'utf8');
  const hasForbidden = forbiddenPatterns.some((re) => re.test(libSrc));
  ok('no real WhatsApp numbers/tokens in notification module/fixtures', !hasForbidden);
}

console.log('verify:staff-whatsapp-notifications\n');

runAsyncTests()
  .then(() => {
    console.log(`\n── staff-whatsapp-notifications: ${pass} passed, ${fail} failed ──`);
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
