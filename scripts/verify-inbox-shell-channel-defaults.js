#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-shell-channel-defaults
 *
 * Offline gate for Inbox mockup slice A: two independent channel-default
 * pills in Inbox chrome (no thread required).
 *
 *   WhatsApp  Auto | Draft | Off
 *   Email     Draft | Off     (never Auto)
 *
 * Persist: prefer PUT /staff/inbox/luna-mode; if that route is not mounted,
 * WhatsApp Off uses today's /staff/bot/global-pause + /staff/bot/global-resume.
 * WhatsApp Draft does not call Graph / Cloud send.
 *
 * Run: node scripts/verify-inbox-shell-channel-defaults.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const {
  SHELL_MODULE,
  VIEWS_MODULE,
  INBOX_VIEWS_INJECT_MARKER,
  injectInboxBrowserModules,
} = require('./lib/inbox-browser-source');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const LUNA_MODE = path.join(ROOT, 'scripts/browser/inbox-luna-mode.js');
const STAFF_API = path.join(ROOT, 'scripts/staff-query-api.js');
const INJECTOR = path.join(ROOT, 'scripts/lib/inbox-browser-source.js');
const I18N = path.join(ROOT, 'scripts/lib/staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts/lib/staff-portal-i18n-es.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function loadShellFns() {
  const store = {};
  const sandbox = {
    t: (key) => key,
    escHtml: (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${read(SHELL_MODULE)}\n` +
    'this.inboxShellChannelOptions = inboxShellChannelOptions;\n' +
    'this.inboxShellNormalizeWhatsApp = inboxShellNormalizeWhatsApp;\n' +
    'this.inboxShellNormalizeEmail = inboxShellNormalizeEmail;\n' +
    'this.inboxShellChannelDefaultsHtml = inboxShellChannelDefaultsHtml;\n' +
    'this.inboxShellChannelSelectHtml = inboxShellChannelSelectHtml;\n' +
    'this.mountInboxShellChrome = mountInboxShellChrome;\n' +
    'this.persistInboxShellChannelMode = persistInboxShellChannelMode;\n' +
    'this.inboxShellFallbackWhatsAppPause = inboxShellFallbackWhatsAppPause;\n' +
    'this.hideInboxDuplicateSchoolSelector = hideInboxDuplicateSchoolSelector;\n',
    sandbox,
  );
  return sandbox;
}

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

function emailI18nAutoHits(pack) {
  return Object.keys(pack || {})
    .filter((k) => /^inbox\.shell\.email\./.test(k) && /auto/i.test(k));
}

function main() {
  console.log('\nverify-inbox-shell-channel-defaults — chrome WhatsApp/Email mode pills\n');

  const shellSrc = read(SHELL_MODULE);
  const threadSrc = read(THREAD);
  const lunaSrc = read(LUNA_MODE);
  const injectorSrc = read(INJECTOR);
  const apiSrc = read(STAFF_API);
  const portalSrc = readStaffPortalUiSource();
  const i18nSrc = read(I18N);
  const i18nEsSrc = read(I18N_ES);
  const fns = loadShellFns();

  console.log('[1] Channel options (WhatsApp three, Email two, no Email Auto)');
  assert('whatsapp options are Auto|Draft|Off',
    JSON.stringify(fns.inboxShellChannelOptions('whatsapp')) === JSON.stringify(['auto', 'draft', 'off']));
  assert('email options are Draft|Off',
    JSON.stringify(fns.inboxShellChannelOptions('email')) === JSON.stringify(['draft', 'off']));
  assert('email options do not include auto',
    fns.inboxShellChannelOptions('email').indexOf('auto') < 0);
  assert('unknown channel does not invent email Auto',
    JSON.stringify(fns.inboxShellChannelOptions('sms')) === JSON.stringify(['auto', 'draft', 'off']));
  assert('email Off/Draft normalize; Auto falls back to Draft',
    fns.inboxShellNormalizeEmail('off') === 'off'
    && fns.inboxShellNormalizeEmail('draft') === 'draft'
    && fns.inboxShellNormalizeEmail('auto') === 'draft'
    && fns.inboxShellNormalizeEmail('nope') === 'draft');

  console.log('\n[2] Both selectors render without a thread selected');
  const html = fns.inboxShellChannelDefaultsHtml({ whatsapp: 'auto', email: 'draft' });
  assert('mount function does not read selectedConvId', !/selectedConvId/.test(shellSrc));
  assert('mount targets inbox-toolbar-top, not conv-detail',
    /el\('inbox-toolbar-top'\)/.test(shellSrc)
    && !/conv-detail|loadConvDetail/.test(shellSrc));
  assert('html always includes both channel selects',
    /id="inbox-shell-whatsapp-mode"/.test(html)
    && /id="inbox-shell-email-mode"/.test(html)
    && /data-inbox-shell-channel="whatsapp"/.test(html)
    && /data-inbox-shell-channel="email"/.test(html));
  assert('whatsapp has Auto, Draft, Off options',
    /<option value="auto"/.test(html)
    && /<option value="draft"/.test(html)
    && /<option value="off"/.test(html));
  {
    const emailBlock = html.slice(html.indexOf('data-inbox-shell-channel="email"'));
    assert('email has Draft and Off',
      /<option value="draft"/.test(emailBlock) && /<option value="off"/.test(emailBlock));
    assert('email DOM has no Auto option', !/<option value="auto"/.test(emailBlock));
  }
  const emailOnly = fns.inboxShellChannelSelectHtml('email', 'draft');
  assert('email-only fragment has no Auto',
    !/value="auto"/.test(emailOnly) && !/>Auto</.test(emailOnly));
  assert('uses existing channel badges, not a new icon set',
    /inbox-channel-badge-whatsapp/.test(html) && /inbox-channel-badge-email/.test(html)
    && !/svg|⌘K|\+ New|cmdk/i.test(html));
  assert('Live status stays in existing toolbar markup',
    /id="inbox-live-status"/.test(apiSrc) && /class="inbox-live-status"/.test(apiSrc)
    && !/⌘K/.test(html) && !/\+ New/.test(html));

  console.log('\n[3] Email has no Auto in i18n');
  assert('no inbox.shell.email.auto key in en',
    emailI18nAutoHits(STAFF_PORTAL_STRINGS.en).length === 0);
  assert('no inbox.shell.email.auto key in es',
    emailI18nAutoHits(STAFF_PORTAL_STRINGS.es).length === 0);
  assert('no inbox.shell.email.auto key in it',
    emailI18nAutoHits(STAFF_PORTAL_STRINGS.it).length === 0);
  assert('shell email i18n files have no Auto option copy',
    !/inbox\.shell\.email\.auto/.test(i18nSrc)
    && !/inbox\.shell\.email\.auto/.test(i18nEsSrc));
  assert('whatsapp shell help includes Auto; email help does not',
    /inbox\.shell\.whatsapp\.autoHelp/.test(i18nSrc)
    && /inbox\.shell\.email\.draftHelp/.test(i18nSrc)
    && /inbox\.shell\.email\.offHelp/.test(i18nSrc)
    && !/inbox\.shell\.email\.autoHelp/.test(i18nSrc));

  console.log('\n[4] Persist path: luna-mode if routed, else pause/resume; Draft does not send');
  const persistFn = sliceFn(shellSrc, 'persistInboxShellChannelMode');
  const putFn = sliceFn(shellSrc, 'inboxShellPutLunaMode');
  const fallbackFn = sliceFn(shellSrc, 'inboxShellFallbackWhatsAppPause');
  const fallbackPersist = sliceFn(shellSrc, 'inboxShellPersistFallback');
  assert('prefers PUT /staff/inbox/luna-mode with scope channel',
    /INBOX_SHELL_LUNA_MODE_PATH = '\/staff\/inbox\/luna-mode'/.test(shellSrc)
    && /fetch\(INBOX_SHELL_LUNA_MODE_PATH/.test(putFn)
    && /method:\s*'PUT'/.test(putFn)
    && /scope:\s*'channel'/.test(putFn));
  assert('Off fallback POSTs /staff/bot/global-pause',
    /\/staff\/bot\/global-pause/.test(fallbackFn)
    && /\/staff\/bot\/global-resume/.test(fallbackFn));
  assert('email Off does not hit WhatsApp pause',
    /if \(channel === 'email'\) return Promise\.resolve\(true\)/.test(fallbackPersist));
  assert('WhatsApp Off maps to paused in fallback',
    /stored\.whatsapp === 'off'/.test(fallbackPersist)
    || /wantPaused = stored\.whatsapp === 'off'/.test(shellSrc));
  assert('shell never calls Graph sendMail or Cloud send',
    !/graph\.microsoft\.com/.test(shellSrc)
    && !/sendMail/.test(shellSrc)
    && !/\/staff\/inbox\/send-reply/.test(shellSrc)
    && !/\/staff\/inbox\/whatsapp\/approve-send/.test(shellSrc)
    && !/\/staff\/inbox\/email\/approve-send/.test(shellSrc)
    && !/_patched_whatsapp_cloud_send/.test(shellSrc));
  assert('WhatsApp Draft persist does not POST a send path',
    /whatsapp/.test(persistFn)
    && !/approve-send/.test(persistFn)
    && !/send-reply/.test(persistFn)
    && !/sendMail/.test(persistFn));
  assert('thread-header WhatsApp control stays Auto|Off (no Draft there)',
    lunaSrc.includes("return ['auto', 'off']")
    && lunaSrc.includes("return ['draft', 'off']")
    && /if \(channel === 'email'\) return \['draft', 'off'\]/.test(lunaSrc)
    && !/return \['auto', 'draft', 'off'\]/.test(lunaSrc));

  console.log('\n[5] School selector slot; header school flip stays');
  const hideFn = sliceFn(shellSrc, 'hideInboxDuplicateSchoolSelector');
  const mountFn = sliceFn(shellSrc, 'mountInboxShellChrome');
  assert('hides #c-client (Sunset Surf School company select) without removing getClient()',
    /el\('c-client'\)/.test(hideFn)
    && /inbox-client-select-hidden/.test(hideFn)
    && /setProperty\('display', 'none', 'important'\)/.test(hideFn)
    && /function getClient\(/.test(apiSrc)
    && /el\('c-client'\)/.test(sliceFn(apiSrc, 'getClient')));
  assert('native company select is display:none, not clip (select ignores sr-only)',
    /#tab-conversations #c-client/.test(shellSrc)
    && /display:none!important/.test(shellSrc)
    && !/clip:rect/.test(shellSrc));
  assert('hides #inbox-school-context even if renderInboxSchoolContext sets display:block',
    /el\('inbox-school-context'\)/.test(hideFn)
    && /renderInboxSchoolContext/.test(hideFn)
    && /#tab-conversations #inbox-school-context/.test(shellSrc));
  assert('does not touch the banner school switch (Sunset | elSardi stays in header)',
    !/staff-school-switch/.test(hideFn)
    && !/staff-school-switch/.test(mountFn)
    && /id="staff-school-switch"/.test(apiSrc)
    && /data-school="sunset-somo"/.test(apiSrc)
    && /data-school="sunset-sardinero"/.test(apiSrc));
  assert('inserts channel pills into the toolbar slot (before refresh / Live)',
    /el\('btn-refresh'\)/.test(mountFn)
    && /insertBefore/.test(mountFn)
    && /id="inbox-live-status"/.test(apiSrc));
  assert('does not revive Pause Luna Globally or add a third Luna badge',
    !/Pause Luna Globally/.test(shellSrc)
    && !/luna-global-pause-switch/.test(shellSrc)
    && !/inbox\.detail\.pill\.luna/.test(shellSrc)
    && !/needs_human/.test(shellSrc));

  console.log('\n[6] Injection + stay-off files');
  assert('inbox-shell.js exists', fs.existsSync(SHELL_MODULE));
  assert('shell is prepended onto the inbox-views inject marker',
    injectorSrc.includes('getInboxShellBrowserSource()')
    && injectorSrc.includes('getInboxViewsBrowserSource()')
    && /return getInboxShellBrowserSource\(\) \+ '\\n' \+ readBrowserModule\(VIEWS_MODULE\)/.test(injectorSrc));
  {
    const injected = injectInboxBrowserModules(`before\n${INBOX_VIEWS_INJECT_MARKER}\nafter\n`);
    assert('injector splices shell + views over the views marker',
      injected.includes('function mountInboxShellChrome(')
      && injected.includes('function inboxSavedViewsUrl(')
      && !injected.includes(INBOX_VIEWS_INJECT_MARKER));
  }
  assert('combined portal UI includes the chrome selects',
    portalSrc.includes('inbox-shell-whatsapp-mode')
    && portalSrc.includes('inbox-shell-email-mode'));
  assert('inbox-thread.js is not edited by this slice (source still has no shell ids)',
    !/inbox-shell-whatsapp-mode/.test(threadSrc)
    && !/mountInboxShellChrome/.test(threadSrc));
  assert('staff-query-api.js has no new luna-mode route in this slice',
    !/\/staff\/inbox\/luna-mode/.test(apiSrc));
  assert('shell is not a column-layout fork',
    !/INBOX_COLUMNS_PRESETS/.test(shellSrc) && !/initInboxColumns\(/.test(shellSrc));
  assert('views module still exists alongside shell', fs.existsSync(VIEWS_MODULE));

  console.log(`\nverify-inbox-shell-channel-defaults: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();
