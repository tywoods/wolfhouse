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
      if (/FROM clients WHERE slug/i.test(q)) {
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
  ok('E.164 regex matches +34900000001', PHONE_RE.test('+34900000001'));

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
    guest_phone: '+34900000099',
    guest_name: 'Alex',
  }, mockSend);
  const second = await dispatchStaffWhatsAppNotifications(pgB, env, {
    client_slug: 'wolfhouse-somo',
    conversation_id: convId,
    notification_type: 'new_conversation',
    guest_phone: '+34900000099',
    guest_name: 'Alex',
  }, mockSend);

  ok('dry-run does not call Meta', metaCalls === 0);
  ok('dry-run records audit row', pgB.events.some((e) => e.status === 'dry_run'));
  ok('dry-run returns message payload shape', !!(first.results && first.results[0] && first.results[0].message));
  ok('dedupe prevents duplicate sends', second.results[0].status === 'duplicate');

  const unknown = await dispatchStaffWhatsAppNotifications(pgB, env, {
    client_slug: 'unknown-client-slug',
    conversation_id: convId,
    notification_type: 'new_conversation',
    guest_phone: '+34900000099',
  }, mockSend);
  ok('unknown/unresolved client sends no notification', unknown.skipped === true && unknown.reason === 'unknown_client');

  ok('env gate defaults disabled', isStaffNotificationsEnabled({}) === false);
  ok('env gate dry-run defaults true', isStaffNotificationsDryRun({}) === true);

  console.log('\n── repo hygiene ──');
  const staffApi = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
  ok('staff API exposes notification settings route', staffApi.includes('/staff/notification-settings'));
  ok('staff API exposes Luna Staff notification UI card', staffApi.includes('cc-staff-notification-settings'));
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
  ok('notification card has labeled global enable row', staffApi.includes('Enable staff WhatsApp alerts'));
  ok('notification card has sns-global-enabled id', staffApi.includes('id="sns-global-enabled"'));
  ok('notification recipient row uses compact grid layout', staffApi.includes('sns-recipient-row'));
  ok('notification recipient row includes name placeholder', staffApi.includes('placeholder="Name"'));
  ok('notification recipient row includes phone placeholder', staffApi.includes('placeholder="+34600000000"'));
  ok('notification recipient row includes enabled label block', staffApi.includes('sns-recipient-enabled'));
  ok('notification recipient row includes remove button', /sns-recipient-remove[\s\S]*Remove/.test(staffApi));
  ok('notification empty state copy exists', staffApi.includes('No recipients yet. Add one staff member to receive these alerts.'));
  ok('notification section titles use new copy', staffApi.includes('New conversation alerts') && staffApi.includes('Human needed alerts'));
  ok('notification server status pill hook exists', staffApi.includes('sns-server-pill') && staffApi.includes('staffNotificationServerPillApply'));

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
