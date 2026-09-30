#!/usr/bin/env node
'use strict';

/**
 * P3-3 — Inbox shows Requiere personal with a visible reason.
 * Staff UI only. Does not change Hermes flag writes.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let failed = 0;

function ok(name, cond) {
  if (cond) console.log('  ok  ' + name);
  else {
    failed += 1;
    console.log('  FAIL ' + name);
  }
}

const queries = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-conversation-queries.js'), 'utf8');
const routes = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-inbox-view-routes.js'), 'utf8');
const views = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-views.js'), 'utf8');
const luna = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-luna-mode.js'), 'utf8');
const thread = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const rows = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-rows.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es.js'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

console.log('\n── payload ──');
ok('list query reads Luna metadata reason',
  queries.includes("conv.metadata->>'needs_human_reason'")
  && queries.includes("conv.metadata->>'luna_handoff_reason'")
  && queries.split('AS needs_human_reason').length >= 4);
ok('list projection keeps the metadata reason',
  routes.includes('row.needs_human_reason = raw.needs_human_reason || null')
  && routes.includes("'needs_human_reason'"));
ok('saved-view map keeps the metadata reason',
  views.includes('needs_human_reason: row.needs_human_reason || null'));

console.log('\n── chrome ──');
ok('header button text stays the raise label',
  luna.includes("btn.textContent = t('inbox.detail.needsHuman.raise')")
  && luna.includes('function inboxNeedsHumanChromeHtml('));
ok('reason sits beside Requiere personal, not inside the button',
  luna.includes('id="inbox-needs-human-reason"')
  && luna.includes('id="inbox-needs-human-chrome"'));
ok('thread header meta prints the reason',
  thread.includes('inboxNeedsHumanReasonText(c)'));
ok('slot moves the reason with the button',
  thread.includes("#inbox-needs-human-chrome"));
ok('list row adds a reason line',
  rows.includes('function inboxRowsNeedsReasonLine(')
  && rows.includes('conv-card-needs-reason'));
ok('reason CSS is visible, not weight 800',
  api.includes('.inbox-needs-human-reason{font-size:12px;font-weight:600')
  && !api.includes('.inbox-needs-human-reason{font-size:12px;font-weight:800'));

console.log('\n── copy ──');
ok('ES fallback is a person, not a blank',
  es.includes('"inbox.detail.needsHuman.reasonFallback": "Luna pidió a una persona"')
  && es.includes('"inbox.detail.needsHuman.raise": "Requiere personal"'));
ok('EN fallback exists',
  en.includes("'inbox.detail.needsHuman.reasonFallback': 'Luna asked for a person'"));

function loadReason(dict) {
  const sandbox = {
    t: function (key) { return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key; },
    portalT: function (key) { return sandbox.t(key); },
    escHtml: function (v) { return String(v == null ? '' : v); },
    conversationHasOpenHandoff: function (conv) {
      return !!(conv && conv.handoff_reason && conv.needs_human);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(luna, sandbox, { filename: 'inbox-luna-mode.js' });
  return sandbox;
}

const enDict = {
  'inbox.detail.needsHuman.raise': 'Needs human',
  'inbox.detail.switch.needsHuman': 'Needs human',
  'inbox.detail.handoff.reason': 'Reason',
  'inbox.detail.needsHuman.reasonFallback': 'Luna asked for a person',
  'inbox.detail.needsHuman.reason.humanRequested': 'Guest asked for a person',
  'inbox.detail.needsHuman.reason.staffMarked': 'Staff marked this',
  'inbox.detail.needsHuman.reason.paymentReported': 'Guest reported a payment problem',
  'inbox.detail.lunaMode.label': 'Luna',
  'inbox.detail.lunaMode.off': 'Off',
  'inbox.detail.lunaMode.autoHelp': '',
  'inbox.detail.lunaMode.offHelp': '',
  'inbox.channelControl.on': 'On',
};
const esDict = {
  'inbox.detail.needsHuman.raise': 'Requiere personal',
  'inbox.detail.switch.needsHuman': 'Requiere personal',
  'inbox.detail.handoff.reason': 'Motivo',
  'inbox.detail.needsHuman.reasonFallback': 'Luna pidió a una persona',
  'inbox.detail.needsHuman.reason.humanRequested': 'El huésped pidió a una persona',
  'inbox.detail.lunaMode.label': 'Luna',
  'inbox.detail.lunaMode.off': 'Off',
  'inbox.detail.lunaMode.autoHelp': '',
  'inbox.detail.lunaMode.offHelp': '',
  'inbox.channelControl.on': 'On',
};

console.log('\n── painted reason ──');
const enBox = loadReason(enDict);
const empty = enBox.inboxNeedsHumanReasonText({ needs_human: true, handoff_reason: null });
ok('empty reason still paints a reason', empty === 'Reason: Luna asked for a person');
const fromMeta = enBox.inboxNeedsHumanReasonText({
  needs_human: true,
  handoff_reason: null,
  needs_human_reason: 'human_requested',
});
ok('metadata reason wins when staff_handoffs reason is empty',
  fromMeta === 'Reason: Guest asked for a person');
const payment = enBox.inboxNeedsHumanReasonText({
  needs_human: true,
  luna_handoff_reason: 'business_tool_error: payment_reported_unresolved',
});
ok('payment report context is readable',
  payment === 'Reason: Guest reported a payment problem');
const quiet = enBox.inboxNeedsHumanReasonText({ needs_human: false });
ok('unflagged thread has no reason chrome', quiet === '');

const flagged = enBox.inboxLunaModeControlHtml({ needs_human: true, channel: 'whatsapp', paused: false });
ok('button stays Needs human',
  flagged.includes('>Needs human</button>')
  && flagged.includes('id="inbox-needs-human-raise"'));
ok('flagged control shows the fallback reason',
  flagged.includes('id="inbox-needs-human-reason"')
  && flagged.includes('Reason: Luna asked for a person')
  && !/id="inbox-needs-human-reason"[^>]*hidden/.test(flagged));
const clear = enBox.inboxLunaModeControlHtml({ needs_human: false, channel: 'whatsapp', paused: false });
ok('cleared control hides the reason',
  /id="inbox-needs-human-reason"[^>]*hidden/.test(clear));

const esBox = loadReason(esDict);
const esEmpty = esBox.inboxNeedsHumanReasonText({ needs_human: true });
ok('ES empty reason is visible', esEmpty === 'Motivo: Luna pidió a una persona');
const esHtml = esBox.inboxLunaModeControlHtml({
  needs_human: true,
  channel: 'whatsapp',
  needs_human_reason: 'human_requested',
});
ok('ES shows Requiere personal with the guest-asked reason',
  esHtml.includes('>Requiere personal</button>')
  && esHtml.includes('Motivo: El huésped pidió a una persona'));

console.log(failed ? '\n' + failed + ' failed' : '\nall passed');
process.exit(failed ? 1 : 0);
