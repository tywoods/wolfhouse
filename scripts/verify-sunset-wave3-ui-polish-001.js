#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const contextSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-context.js'), 'utf8');
const shellSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-shell.js'), 'utf8');
const rowsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-rows.js'), 'utf8');
const emailSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const financeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
let pass = 0;
function ok(name, value) {
  if (!value) throw new Error('FAIL ' + name);
  pass += 1;
  console.log('PASS ' + name);
}

ok('desktop email rule is Sunset-scoped and starts at 1280px',
  contextSrc.includes('@media(min-width:1280px)')
  && contextSrc.includes('html[data-portal-client="sunset"] #inbox-shell:has(#inbox-email-reply-subject)'));
ok('desktop email rule guarantees a 520px reading pane',
  contextSrc.includes('minmax(520px,1fr)'));
ok('desktop email rule does not target Wolfhouse fallback selector',
  !contextSrc.includes('html:not([data-portal-client]) #inbox-shell:has(#inbox-email-reply-subject)'));

const mobileRules = shellSrc.match(/#tab-conversations #inbox-shell:not\(\.show-thread\)[^']+touch-action:pan-y/g) || [];
ok('phone Chats and Guests list scroller allows vertical touch panning', mobileRules.length >= 2);
ok('phone row children and conversation list allow vertical touch panning',
  shellSrc.includes('.inbox-left-rows > *,#tab-conversations #inbox-shell:not(.show-thread) #conv-list{touch-action:pan-y}'));
ok('open thread keeps vertical touch panning and permits document-owned phone scrolling',
  rowsSrc.includes('-webkit-overflow-scrolling:touch;overscroll-behavior:auto;touch-action:pan-y;'));

ok('Microsoft disconnect status no longer claims processing is already off',
  emailSrc.includes('stops email processing.')
  && emailSrc.includes('detiene el procesamiento de email.')
  && !emailSrc.includes('Disconnect revokes Microsoft mailbox access. Email processing stays off.'));
ok('connection capability is named as endpoint processing',
  emailSrc.includes("'Email processing', 'Procesamiento de email'"));
ok('mailbox wording is consistent in the real EN/ES catalogs',
  STAFF_PORTAL_STRINGS.en['admin.email.state.connected_health'] === 'Mailbox connected.'
  && STAFF_PORTAL_STRINGS.es['admin.email.state.connected_health'] === 'Buzón conectado.'
  && STAFF_PORTAL_STRINGS.en['admin.email.disconnectSafetyNote'].includes('stops email processing')
  && STAFF_PORTAL_STRINGS.es['admin.email.disconnectSafetyNote'].includes('detiene el procesamiento'));
ok('endpoint and capacity labels are catalog-backed in EN/ES',
  STAFF_PORTAL_STRINGS.en['admin.email.endpointProcessing'] === 'Email processing'
  && STAFF_PORTAL_STRINGS.es['admin.email.endpointProcessing'] === 'Procesamiento de email'
  && STAFF_PORTAL_STRINGS.en['admin.finance.capacityCount'] === '{used} of {capacity}'
  && STAFF_PORTAL_STRINGS.es['admin.finance.capacityCount'] === '{used} de {capacity}');

const sandbox = { console, window: {}, document: {}, Intl, Date, Math, Number, String, Array, Object, RegExp, JSON, isFinite, portalLang: 'en' };
sandbox.portalT = key => (STAFF_PORTAL_STRINGS[sandbox.portalLang] || STAFF_PORTAL_STRINGS.en)[key] || key;
vm.createContext(sandbox);
vm.runInContext(financeSrc, sandbox);
sandbox.portalLang = 'en';
ok('equipment usage explains numerator and capacity in English',
  sandbox.financeRedesignCapacityDetail('157/50') === '157 of 50');
sandbox.portalLang = 'es';
ok('equipment usage explains numerator and capacity in Spanish',
  sandbox.financeRedesignCapacityDetail('157/50') === '157 de 50');
ok('equipment formatter does not change the calculation or arbitrary labels',
  sandbox.financeRedesignCapacityDetail('30%') === '30%');

console.log(`OK ${pass} checks`);
