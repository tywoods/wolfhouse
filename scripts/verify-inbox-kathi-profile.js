#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) return '';
  let brace = 0;
  let started = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      brace += 1;
      started = true;
    } else if (ch === '}') {
      brace -= 1;
      if (started && brace === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const columnsSrc = fs.readFileSync(path.join(root, 'scripts/browser/inbox-columns.js'), 'utf8');
const contextSrc = fs.readFileSync(path.join(root, 'scripts/browser/inbox-context.js'), 'utf8');
const viewsSrc = fs.readFileSync(path.join(root, 'scripts/browser/inbox-views.js'), 'utf8');
const threadSrc = fs.readFileSync(path.join(root, 'scripts/browser/inbox-thread.js'), 'utf8');

const colNames = [
  'staffChromeHonestPhone',
  'staffChromeIsDurableLabPhone',
  'staffChromeCollectPhones',
  'staffChromeDurablePhone',
];
const phoneCtx = {};
vm.createContext(phoneCtx);
vm.runInContext(colNames.map((n) => extractFunction(columnsSrc, n)).join('\n') +
  '\nthis.staffChromeDurablePhone = staffChromeDurablePhone;', phoneCtx);
const durablePhone = phoneCtx.staffChromeDurablePhone;

const kathiPhone = '+99900000002';
const albaPhone = '+99900000001';
assert.equal(
  durablePhone({ phone: kathiPhone, customer_id: 'kathi' }, { phone: albaPhone, customer_id: 'alba' }),
  kathiPhone,
  'current conversation phone wins over another record +999',
);
assert.match(contextSrc, /inboxCustomerResolvePhone\(\s*conv\s*,\s*null\s*\)/);
assert.match(contextSrc, /inboxViewsMatchGuestRow|customer_id/);
assert.match(threadSrc, /inboxChatPaintGuest/);
assert.match(viewsSrc, /function inboxViewsMatchGuestRow/);

function miniEl(id) {
  return {
    id,
    innerHTML: '',
    hidden: false,
    querySelector() { return null; },
    addEventListener() {},
  };
}

const sidebar = miniEl('inbox-detail-sidebar');
const host = miniEl('inbox-chat-guest-host');
const painted = [];

const sandbox = {
  window: {},
  document: {
    getElementById(id) {
      if (id === 'inbox-detail-sidebar') return sidebar;
      if (id === 'inbox-chat-guest-host') return host;
      return null;
    },
  },
  console,
  staffChromeDurablePhone: durablePhone,
  staffChromeIsDurableLabPhone: phoneCtx.staffChromeIsDurableLabPhone || function (p) {
    return String(p || '').indexOf('+999') === 0;
  },
  inboxChromePhone: durablePhone,
  normalizeCustomerPhoneClient: (p) => String(p || '').trim(),
  inboxPersonDisplayName: (c) => (c && c.guest_name) || '',
  inboxCustomerFullHtml(data) {
    const name = (data && data.identity && data.identity.display_name) || (data && data.phone) || '';
    painted.push(name);
    return '<div class="inbox-customer-card">' + name + '</div>';
  },
  inboxCustomerCondensedHtml(data) {
    return sandbox.inboxCustomerFullHtml(data);
  },
  inboxCustomerFromConv(conv) {
    conv = conv || {};
    return {
      customer_id: conv.customer_id || '',
      phone: conv.phone || '',
      identity: { display_name: conv.guest_name || '' },
    };
  },
  inboxCustomerMerge(a, b) {
    return Object.assign({}, a || {}, b || {}, {
      identity: Object.assign({}, (a && a.identity) || {}, (b && b.identity) || {}),
    });
  },
  inboxCustomerHasBoundGuest(conv, customer) {
    return !!(conv && (conv.customer_id || conv.phone)) || !!(customer && customer.customer_id);
  },
  inboxCustomerResolveBookings() { return []; },
  inboxContextSidebarEl() { return sidebar; },
  inboxContextIsGuestMode() { return true; },
  inboxContextWireActions() {},
  inboxCustomerWireFull() {},
  inboxViewsMatchGuestRow(row, phone, customerId) {
    if (!row) return false;
    const want = String(customerId || '').trim();
    if (want) return String(row.customer_id || '').trim() === want;
    return String(row.phone || '') === String(phone || '');
  },
  fetch() {
    return Promise.resolve({
      ok: true,
      json() {
        return Promise.resolve({
          success: true,
          customer_id: 'alba',
          phone: albaPhone,
          identity: { display_name: 'Alba Test' },
        });
      },
    });
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const loadSrc = extractFunction(contextSrc, 'inboxCustomerPaint')
  + '\n' + extractFunction(contextSrc, 'inboxCustomerResolvePhone')
  + '\n' + extractFunction(contextSrc, 'inboxCustomerLoad')
  + '\n' + extractFunction(threadSrc, 'inboxChatPaintGuest');
vm.runInContext(
  'var inboxContextLastCustomer = null;\n'
  + 'var inboxContextLastConv = null;\n'
  + 'var inboxContextLastComposite = null;\n'
  + 'var inboxClientInfoFetchGen = 0;\n'
  + 'var inboxCustomerEditing = false;\n'
  + loadSrc + '\n'
  + 'this.inboxCustomerLoad = inboxCustomerLoad;\n'
  + 'this.inboxCustomerPaint = inboxCustomerPaint;\n'
  + 'this.inboxChatPaintGuest = inboxChatPaintGuest;\n'
  + 'this.getLastCustomer = function(){ return inboxContextLastCustomer; };\n',
  sandbox,
);

const alba = {
  conversation_id: 'conv-alba',
  customer_id: 'alba',
  guest_name: 'Alba Test',
  phone: albaPhone,
};
const kathi = {
  conversation_id: 'conv-kathi',
  customer_id: 'kathi',
  guest_name: 'Kathi',
  phone: kathiPhone,
};

sandbox.inboxCustomerPaint(sidebar, alba, {}, {
  customer_id: 'alba',
  phone: albaPhone,
  identity: { display_name: 'Alba Test' },
});
assert.match(sidebar.innerHTML, /Alba Test/);

painted.length = 0;
sandbox.inboxCustomerLoad(sidebar, kathi, {});
assert.doesNotMatch(sidebar.innerHTML, /Alba Test/);
assert.equal(sandbox.getLastCustomer() == null || sandbox.getLastCustomer().customer_id !== 'alba', true);

Promise.resolve().then(function () {
  assert.doesNotMatch(sidebar.innerHTML, /Alba Test/, 'stale Alba fetch must not paint on Kathi');
  sandbox.inboxChatPaintGuest();
  assert.doesNotMatch(host.innerHTML, /Alba Test/);
  console.log('ok kathi guest profile is not Alba');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
