'use strict';

/**
 * Focused offline gate: Guest Conversation Alerts checkbox/pebble cleanup +
 * Booking Edit drawer body-scroll CSS/runtime owner.
 * No HTTP, DB, Azure, or deploy.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const CONTROLLER = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');

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

const staffApi = fs.readFileSync(STAFF_API, 'utf8');
const controllerSrc = fs.readFileSync(CONTROLLER, 'utf8');

const cardStart = staffApi.indexOf('id="cc-staff-notification-settings"');
const cardEnd = staffApi.indexOf('id="cc-house-notes"', cardStart);
const cardHtml = cardStart >= 0 && cardEnd > cardStart ? staffApi.slice(cardStart, cardEnd) : '';

console.log('verify:guest-conversation-alerts-edit-scroll-ui\n');

console.log('── markup: exactly two alert checkboxes ──');
ok('Guest Conversation Alerts card present', !!cardHtml);
ok('heading + description kept', cardHtml.includes('>Guest Conversation Alerts</div>')
  && cardHtml.includes('Send WhatsApp alerts when Luna starts a guest conversation or needs human help.'));
ok('no global enable checkbox', !cardHtml.includes('sns-global-enabled') && !cardHtml.includes('Enable staff WhatsApp alerts'));
ok('no top-level server pebble', !cardHtml.includes('id="sns-server-pill"'));
ok('no per-recipient Enabled controls in card shell', !cardHtml.includes('sns-recipient-enabled'));
const typeChecks = (cardHtml.match(/type="checkbox"/g) || []).length;
ok('exactly 2 checkboxes in section markup', typeChecks === 2);
ok('new + human type checkboxes present', cardHtml.includes('id="sns-new-enabled"') && cardHtml.includes('id="sns-human-enabled"'));
ok('type labels adjacent to sole checkboxes',
  /sns-new-enabled[\s\S]{0,120}New conversation alerts/.test(cardHtml)
  && /sns-human-enabled[\s\S]{0,120}Human needed alerts/.test(cardHtml));
ok('per-type pebbles in title rows', cardHtml.includes('id="sns-new-pill"') && cardHtml.includes('id="sns-human-pill"'));
ok('server-disabled note copy present', cardHtml.includes('Configured on, but delivery is disabled by the server.'));
ok('Add recipient preserved', cardHtml.includes("staffNotificationRecipientAdd('new_conversation')")
  && cardHtml.includes("staffNotificationRecipientAdd('human_needed')"));
ok('recipient render has no Enabled checkbox',
  /function staffNotificationRecipientRender[\s\S]*?^}/m.test(staffApi)
  && !/function staffNotificationRecipientRender[\s\S]*?sns-recipient-enabled/.test(staffApi));
ok('serializer does not read removed controls',
  !/sns-global-enabled/.test(staffApi)
  && !/id \+ '-enabled'/.test(staffApi)
  && /enabled:\s*true/.test(staffApi)
  && /function staffNotificationSettingsCollectFromForm/.test(staffApi));

console.log('\n── runtime: serialize + round-trip + pebbles ──');
{
  const start = staffApi.indexOf('var staffNotificationSettingsCache =');
  const end = staffApi.indexOf('function maybeLoadStaffNotificationSettings', start);
  ok('extracted notification helpers region', start >= 0 && end > start);
  const helpers = staffApi.slice(start, end);

  function makeInput(value, checked) {
    return {
      value: value == null ? '' : String(value),
      checked: !!checked,
      style: {},
      className: '',
      textContent: '',
    };
  }
  function makeHost() {
    const host = {
      _children: [],
      innerHTML: '',
      querySelectorAll(sel) {
        const list = host._children || [];
        const s = String(sel || '');
        const m = s.match(/\[data-sns-type=["']([^"']+)["']\]/);
        if (m) {
          return list.filter((c) => c.getAttribute && c.getAttribute('data-sns-type') === m[1]);
        }
        return list.slice();
      },
    };
    return host;
  }

  const state = {
    cache: { new_conversation: { enabled: false, recipients: [] }, human_needed: { enabled: false, recipients: [] } },
    serverMeta: { server_notifications_enabled: false, server_notifications_dry_run: true },
    nodes: {},
    hosts: {
      'sns-new-recipients': makeHost(),
      'sns-human-recipients': makeHost(),
    },
  };

  function el(id) {
    if (state.hosts[id]) return state.hosts[id];
    if (!state.nodes[id]) state.nodes[id] = makeInput('', false);
    return state.nodes[id];
  }

  // Minimal DOM for recipients after render — collect reads via querySelectorAll + el(id-name/phone).
  function installRecipientDom(type, recipients) {
    const hostId = type === 'human_needed' ? 'sns-human-recipients' : 'sns-new-recipients';
    const host = state.hosts[hostId];
    host._children = [];
    (recipients || []).forEach((r, idx) => {
      const prefix = 'sns-' + (type === 'human_needed' ? 'human' : 'new') + '-r-' + idx;
      state.nodes[prefix + '-name'] = makeInput(r.name || '', false);
      state.nodes[prefix + '-phone'] = makeInput(r.phone || '', false);
      host._children.push({
        getAttribute(k) {
          if (k === 'data-sns-type') return type;
          if (k === 'data-sns-idx') return String(idx);
          return null;
        },
      });
    });
  }

  const sandbox = {
    el,
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
    staffNotificationSettingsCache: state.cache,
    staffNotificationServerMeta: state.serverMeta,
    console,
  };

  // Bind cache/meta as mutable sandbox props used by helpers.
  const wrapped = helpers
    .replace(/var staffNotificationSettingsCache =[\s\S]*?;\n/, '')
    .replace(/var staffNotificationServerMeta =[\s\S]*?;\n/, '')
    .replace(/var staffNotificationSettingsFetchInFlight =[\s\S]*?;\n/, '');

  vm.runInNewContext(
    wrapped
      + '\nthis.staffNotificationRecipientRender = staffNotificationRecipientRender;'
      + '\nthis.staffNotificationTypePillApplyOne = staffNotificationTypePillApplyOne;'
      + '\nthis.staffNotificationTypePillSync = staffNotificationTypePillSync;'
      + '\nthis.staffNotificationServerPillApply = staffNotificationServerPillApply;'
      + '\nthis.staffNotificationSettingsApplyToForm = staffNotificationSettingsApplyToForm;'
      + '\nthis.staffNotificationSettingsCollectFromForm = staffNotificationSettingsCollectFromForm;'
      + '\nthis.staffNotificationRecipientAdd = staffNotificationRecipientAdd;'
      + '\nthis.staffNotificationRecipientRemove = staffNotificationRecipientRemove;'
      + '\nthis.getCache = function(){ return staffNotificationSettingsCache; };'
      + '\nthis.setCache = function(v){ staffNotificationSettingsCache = v; };'
      + '\nthis.getServerMeta = function(){ return staffNotificationServerMeta; };',
    sandbox
  );

  // Seed recipients via cache + apply.
  sandbox.setCache({
    new_conversation: {
      enabled: true,
      recipients: [{ name: 'Ana', phone: '+34611111111', enabled: true }],
    },
    human_needed: {
      enabled: false,
      recipients: [{ name: 'Bea', phone: '+34622222222', enabled: true }],
    },
  });
  state.nodes['sns-new-enabled'] = makeInput('', true);
  state.nodes['sns-human-enabled'] = makeInput('', false);
  state.nodes['sns-new-pill'] = makeInput('', false);
  state.nodes['sns-human-pill'] = makeInput('', false);
  state.nodes['sns-new-server-note'] = makeInput('', false);
  state.nodes['sns-human-server-note'] = makeInput('', false);

  // Server disabled — pebbles always Disabled on server; note only when configured on.
  sandbox.staffNotificationServerPillApply({ server_notifications_enabled: false, server_notifications_dry_run: true });
  installRecipientDom('new_conversation', sandbox.getCache().new_conversation.recipients);
  installRecipientDom('human_needed', sandbox.getCache().human_needed.recipients);
  sandbox.staffNotificationSettingsApplyToForm();
  ok('server-off toggles are disabled', el('sns-new-enabled').disabled === true && el('sns-human-enabled').disabled === true);
  ok('server-off toggles do not look checked', el('sns-new-enabled').checked === false && el('sns-human-enabled').checked === false);
  // applyToForm re-renders hosts via innerHTML string — reinstall collect-friendly DOM.
  installRecipientDom('new_conversation', [
    { name: el('sns-new-r-0-name') ? el('sns-new-r-0-name').value : 'Ana', phone: '+34611111111' },
  ]);
  // After applyToForm, recipient fields are only in innerHTML; re-seed for collect.
  installRecipientDom('new_conversation', [{ name: 'Ana', phone: '+34611111111' }]);
  installRecipientDom('human_needed', [{ name: 'Bea', phone: '+34622222222' }]);
  el('sns-new-enabled').checked = true;
  el('sns-human-enabled').checked = false;
  sandbox.staffNotificationTypePillSync();

  ok('server-off + configured-on pebble is Disabled on server', el('sns-new-pill').textContent === 'Disabled on server');
  ok('server-off + configured-off pebble is Disabled on server', el('sns-human-pill').textContent === 'Disabled on server');
  ok('server-disabled note shows only when configured on',
    el('sns-new-server-note').style.display !== 'none'
    && el('sns-human-server-note').style.display === 'none');

  // Server on — pebbles follow type checkbox.
  sandbox.staffNotificationServerPillApply({ server_notifications_enabled: true, server_notifications_dry_run: false });
  el('sns-new-enabled').checked = true;
  el('sns-human-enabled').checked = false;
  sandbox.staffNotificationTypePillSync();
  ok('server-on + checked pebble Enabled', el('sns-new-pill').textContent === 'Enabled' && /pill-green/.test(el('sns-new-pill').className));
  ok('server-on + unchecked pebble Disabled', el('sns-human-pill').textContent === 'Disabled');
  ok('server-disabled notes hidden when server on',
    el('sns-new-server-note').style.display === 'none'
    && el('sns-human-server-note').style.display === 'none');

  installRecipientDom('new_conversation', [{ name: 'Ana', phone: '+34611111111' }]);
  installRecipientDom('human_needed', [{ name: 'Bea', phone: '+34622222222' }]);
  el('sns-new-enabled').checked = true;
  el('sns-human-enabled').checked = false;
  let payload = sandbox.staffNotificationSettingsCollectFromForm();
  ok('new_conversation enabled from its checkbox', payload.new_conversation.enabled === true);
  ok('human_needed disabled from its checkbox', payload.human_needed.enabled === false);
  ok('recipients preserved with names/phones',
    payload.new_conversation.recipients.length === 1
    && payload.new_conversation.recipients[0].name === 'Ana'
    && payload.new_conversation.recipients[0].phone === '+34611111111'
    && payload.human_needed.recipients[0].name === 'Bea'
    && payload.human_needed.recipients[0].phone === '+34622222222');
  ok('listed recipients serialize as enabled/active',
    payload.new_conversation.recipients.every((r) => r.enabled === true)
    && payload.human_needed.recipients.every((r) => r.enabled === true));

  // Independent round-trip: flip types, preserve recipients.
  el('sns-new-enabled').checked = false;
  el('sns-human-enabled').checked = true;
  payload = sandbox.staffNotificationSettingsCollectFromForm();
  ok('types serialize independently after flip',
    payload.new_conversation.enabled === false && payload.human_needed.enabled === true);
  ok('recipient payload still preserved after type flip',
    payload.new_conversation.recipients[0].phone === '+34611111111'
    && payload.human_needed.recipients[0].phone === '+34622222222');

  // Round-trip applyToForm from payload.
  sandbox.setCache({
    new_conversation: payload.new_conversation,
    human_needed: payload.human_needed,
  });
  sandbox.staffNotificationSettingsApplyToForm();
  ok('round-trip applies type checkboxes independently',
    el('sns-new-enabled').checked === false && el('sns-human-enabled').checked === true);

  // Checkbox count in live card: only the two type inputs exist as checkboxes.
  const liveChecks = ['sns-new-enabled', 'sns-human-enabled'].filter((id) => el(id));
  ok('runtime only tracks 2 type checkboxes', liveChecks.length === 2);
  ok('no global/recipient enabled node ids', !state.nodes['sns-global-enabled'] && !Object.keys(state.nodes).some((k) => /-enabled$/.test(k) && k !== 'sns-new-enabled' && k !== 'sns-human-enabled'));
}

console.log('\n── edit drawer scroll CSS + runtime owner ──');
ok('edit shell CSS uses :has(#ps-drawer-edit-form)',
  /portal-schedule-drawer:has\(#ps-drawer-edit-form\)\{[^}]*display:flex/.test(staffApi)
  && /overflow:hidden/.test(staffApi));
ok('edit body is the only vertical scroll surface',
  /\.portal-schedule-drawer-edit-body\{[^}]*overflow-y:auto/.test(staffApi)
  && /#ps-drawer-edit-form\.portal-schedule-drawer-edit\{[^}]*overflow:hidden/.test(staffApi)
  && /\.portal-schedule-drawer:has\(#ps-drawer-edit-form\)\{[^}]*overflow:hidden/.test(staffApi));
ok('edit body height chain uses flex 0% basis + min-height 0',
  /\.portal-schedule-drawer:has\(#ps-drawer-edit-form\) #ps-drawer-body\{[^}]*flex:1 1 0%[^}]*min-height:0/.test(staffApi)
  && /#ps-drawer-edit-form\.portal-schedule-drawer-edit\{[^}]*flex:1 1 0%[^}]*height:100%/.test(staffApi)
  && /\.portal-schedule-drawer-edit-body\{[^}]*flex:1 1 0%[^}]*min-height:0/.test(staffApi));
ok('sticky header/footer kept',
  /\.portal-schedule-drawer-edit-header\{[^}]*position:sticky/.test(staffApi)
  && /\.portal-schedule-drawer-edit-footer\{[^}]*position:sticky/.test(staffApi));
ok('touch/wheel scroll affordances on edit body',
  /\.portal-schedule-drawer-edit-body\{[^}]*-webkit-overflow-scrolling:touch/.test(staffApi)
  && /\.portal-schedule-drawer-edit-body\{[^}]*overscroll-behavior:contain/.test(staffApi)
  && /\.portal-schedule-drawer-edit-body\{[^}]*touch-action:pan-y/.test(staffApi));
ok('runtime opens edit drawer as display:flex (not block override)',
  /display = editing \? 'flex' : 'block'/.test(controllerSrc)
  || /drawer\.style\.display = editing \? ['"]flex['"] : ['"]block['"]/.test(controllerSrc));
ok('runtime detects #ps-drawer-edit-form for flex open',
  /querySelector\(['"]#ps-drawer-edit-form['"]\)/.test(controllerSrc));

console.log(`\n── guest-conversation-alerts-edit-scroll-ui: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
