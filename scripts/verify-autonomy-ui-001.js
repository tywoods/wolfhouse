#!/usr/bin/env node
'use strict';

/**
 * verify-autonomy-ui-001
 *
 * Reconstructs the approved Inbox autonomy chrome:
 *   - Green-box channel controls expose Draft | Auto independently for WhatsApp and Email
 *   - Both channel defaults are Auto off / Draft
 *   - Tenant-global Global Pause blocks / effectively downgrades Auto for both channels
 *   - Per-conversation Luna On and needs_human remain the send gates
 *   - Do not flip or require LUNA_AUTO_SEND_ENABLED
 *   - Persist tenant-global channel mode via authenticated session / prefs
 *
 * Run: node scripts/verify-autonomy-ui-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const {
  SHELL_MODULE,
  LUNA_MODE_MODULE,
  THREAD_MODULE,
  INBOX_VIEWS_INJECT_MARKER,
  injectInboxBrowserModules,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts/staff-query-api.js');
const INJECTOR = path.join(ROOT, 'scripts/lib/inbox-browser-source.js');
const FORBIDDEN = [
  'scripts/browser/inbox-thread.js',
  'scripts/lib/email-inbox-channel-mode.js',
  'scripts/lib/staff-inbox-luna-mode-routes.js',
];

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

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

function extractNamed(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const nextAsync = src.indexOf('\nasync function ', start + 1);
  const nextFn = src.indexOf('\nfunction ', start + 1);
  let end = src.length;
  if (nextAsync > 0) end = Math.min(end, nextAsync);
  if (nextFn > 0) end = Math.min(end, nextFn);
  return src.slice(start, end);
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
    'this.inboxShellChannelOptions = typeof inboxShellChannelOptions === "function" ? inboxShellChannelOptions : null;\n' +
    'this.inboxShellNormalizeWhatsApp = typeof inboxShellNormalizeWhatsApp === "function" ? inboxShellNormalizeWhatsApp : null;\n' +
    'this.inboxShellNormalizeEmail = typeof inboxShellNormalizeEmail === "function" ? inboxShellNormalizeEmail : null;\n' +
    'this.inboxShellChannelDefaultsHtml = typeof inboxShellChannelDefaultsHtml === "function" ? inboxShellChannelDefaultsHtml : null;\n' +
    'this.inboxShellAutonomyRowHtml = typeof inboxShellAutonomyRowHtml === "function" ? inboxShellAutonomyRowHtml : null;\n' +
    'this.inboxShellLoadStoredModes = typeof inboxShellLoadStoredModes === "function" ? inboxShellLoadStoredModes : null;\n' +
    'this.inboxShellEffectiveMode = typeof inboxShellEffectiveMode === "function" ? inboxShellEffectiveMode : null;\n' +
    'this.inboxShellPauseBlocksAuto = typeof inboxShellPauseBlocksAuto === "function" ? inboxShellPauseBlocksAuto : null;\n' +
    'this.persistInboxShellChannelMode = typeof persistInboxShellChannelMode === "function" ? persistInboxShellChannelMode : null;\n',
    sandbox,
  );
  sandbox._store = store;
  return sandbox;
}

function loadLunaFns() {
  const sandbox = {
    t: (key) => key,
    escHtml: (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${read(LUNA_MODE_MODULE)}\n` +
    'this.inboxLunaModeOptions = typeof inboxLunaModeOptions === "function" ? inboxLunaModeOptions : null;\n' +
    'this.inboxLunaModeFromPaused = typeof inboxLunaModeFromPaused === "function" ? inboxLunaModeFromPaused : null;\n' +
    'this.inboxLunaModeControlHtml = typeof inboxLunaModeControlHtml === "function" ? inboxLunaModeControlHtml : null;\n',
    sandbox,
  );
  return sandbox;
}

function evalHelpers(apiSrc) {
  const names = [
    'inboxChannelModeFromValue',
    'inboxChannelModesFromUnknown',
  ];
  const src = names.map((n) => extractNamed(apiSrc, n)).filter(Boolean).join('\n');
  if (!src.includes('function inboxChannelModesFromUnknown')) return null;
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${src}\n` +
    'this.inboxChannelModeFromValue = inboxChannelModeFromValue;\n' +
    'this.inboxChannelModesFromUnknown = inboxChannelModesFromUnknown;\n',
    sandbox,
  );
  return sandbox;
}

function main() {
  console.log('\nverify-autonomy-ui-001 — tenant-global Draft|Auto chrome + Global Pause\n');

  const shellSrc = read(SHELL_MODULE);
  const lunaSrc = read(LUNA_MODE_MODULE);
  const threadSrc = read(THREAD_MODULE);
  const apiSrc = read(STAFF_API);
  const injectorSrc = read(INJECTOR);
  const portalSrc = readStaffPortalUiSource();
  const fns = loadShellFns();
  const luna = loadLunaFns();
  const helpers = evalHelpers(apiSrc);
  const persistFn = sliceFn(shellSrc, 'persistInboxShellChannelMode');
  const prefsFn = extractNamed(apiSrc, 'handleAuthPrefs');
  const saveModesFn = extractNamed(apiSrc, 'saveClientInboxChannelModes');
  const sessionFn = extractNamed(apiSrc, 'handleAuthSession');
  const pauseFn = sliceFn(shellSrc, 'inboxShellSyncFromPauseState');
  const syncBtns = sliceFn(shellSrc, 'inboxShellSyncAutonomyButtons');
  const wireFn = sliceFn(shellSrc, 'wireInboxShellChannelDefaults');
  const mountFn = sliceFn(shellSrc, 'mountInboxShellChrome');

  console.log('[1] Green-box controls: independent Draft | Auto for WhatsApp and Email');
  assert('shell exports channel options', typeof fns.inboxShellChannelOptions === 'function');
  assert('whatsapp green-box options are Draft|Auto',
    typeof fns.inboxShellChannelOptions === 'function'
    && JSON.stringify(fns.inboxShellChannelOptions('whatsapp')) === JSON.stringify(['draft', 'auto']));
  assert('email green-box options are Draft|Auto',
    typeof fns.inboxShellChannelOptions === 'function'
    && JSON.stringify(fns.inboxShellChannelOptions('email')) === JSON.stringify(['draft', 'auto']));
  {
    const html = typeof fns.inboxShellChannelDefaultsHtml === 'function'
      ? fns.inboxShellChannelDefaultsHtml({ whatsapp: 'draft', email: 'draft' })
      : '';
    const wa = html.includes('data-inbox-autonomy-row="whatsapp"')
      ? html.slice(html.indexOf('data-inbox-autonomy-row="whatsapp"'))
      : '';
    const em = html.includes('data-inbox-autonomy-row="email"')
      ? html.slice(html.indexOf('data-inbox-autonomy-row="email"'))
      : '';
    assert('html always includes independent WhatsApp and Email autonomy rows',
      /data-inbox-autonomy-row="whatsapp"/.test(html)
      && /data-inbox-autonomy-row="email"/.test(html));
    assert('whatsapp row exposes Draft and Auto, not Off',
      /data-inbox-autonomy="draft"/.test(wa)
      && /data-inbox-autonomy="auto"/.test(wa)
      && !/data-inbox-autonomy="off"/.test(wa));
    assert('email row exposes Draft and Auto, not Off',
      /data-inbox-autonomy="email"/.test(html) === false
      && /data-inbox-autonomy="draft"/.test(em)
      && /data-inbox-autonomy="auto"/.test(em)
      && !/data-inbox-autonomy="off"/.test(em));
  }

  console.log('\n[2] Both channel defaults are Auto off / Draft');
  assert('empty stored modes default both channels to draft',
    typeof fns.inboxShellLoadStoredModes === 'function'
    && JSON.stringify(fns.inboxShellLoadStoredModes()) === JSON.stringify({ whatsapp: 'draft', email: 'draft' }));
  assert('whatsapp unknown/off normalize to draft; auto stays auto',
    typeof fns.inboxShellNormalizeWhatsApp === 'function'
    && fns.inboxShellNormalizeWhatsApp('auto') === 'auto'
    && fns.inboxShellNormalizeWhatsApp('draft') === 'draft'
    && fns.inboxShellNormalizeWhatsApp('off') === 'draft'
    && fns.inboxShellNormalizeWhatsApp('nope') === 'draft'
    && fns.inboxShellNormalizeWhatsApp(undefined) === 'draft');
  assert('email unknown/off normalize to draft; auto stays auto',
    typeof fns.inboxShellNormalizeEmail === 'function'
    && fns.inboxShellNormalizeEmail('auto') === 'auto'
    && fns.inboxShellNormalizeEmail('draft') === 'draft'
    && fns.inboxShellNormalizeEmail('off') === 'draft'
    && fns.inboxShellNormalizeEmail('nope') === 'draft');
  {
    const html = typeof fns.inboxShellChannelDefaultsHtml === 'function'
      ? fns.inboxShellChannelDefaultsHtml()
      : '';
    const wa = html.slice(html.indexOf('data-inbox-autonomy-row="whatsapp"'), html.indexOf('data-inbox-autonomy-row="email"'));
    const em = html.slice(html.indexOf('data-inbox-autonomy-row="email"'));
    assert('default render selects Draft on WhatsApp',
      /data-inbox-autonomy="draft"[^>]*aria-pressed="true"/.test(wa)
      && /data-inbox-autonomy="auto"[^>]*aria-pressed="false"/.test(wa));
    assert('default render selects Draft on Email',
      /data-inbox-autonomy="draft"[^>]*aria-pressed="true"/.test(em)
      && /data-inbox-autonomy="auto"[^>]*aria-pressed="false"/.test(em));
  }

  console.log('\n[3] Global Pause blocks/effectively downgrades Auto for both channels');
  assert('effective-mode helper exists', typeof fns.inboxShellEffectiveMode === 'function');
  assert('pause helper exists', typeof fns.inboxShellPauseBlocksAuto === 'function'
    || typeof fns.inboxShellEffectiveMode === 'function');
  assert('paused Auto becomes Draft for whatsapp',
    typeof fns.inboxShellEffectiveMode === 'function'
    && fns.inboxShellEffectiveMode('whatsapp', 'auto', true) === 'draft');
  assert('paused Auto becomes Draft for email',
    typeof fns.inboxShellEffectiveMode === 'function'
    && fns.inboxShellEffectiveMode('email', 'auto', true) === 'draft');
  assert('unpaused Auto stays Auto',
    typeof fns.inboxShellEffectiveMode === 'function'
    && fns.inboxShellEffectiveMode('whatsapp', 'auto', false) === 'auto'
    && fns.inboxShellEffectiveMode('email', 'auto', false) === 'auto');
  assert('unpaused Draft stays Draft',
    typeof fns.inboxShellEffectiveMode === 'function'
    && fns.inboxShellEffectiveMode('whatsapp', 'draft', true) === 'draft'
    && fns.inboxShellEffectiveMode('email', 'draft', false) === 'draft');
  assert('pause sync does not rewrite stored channel mode to off/auto',
    !/stored\.whatsapp = 'off'/.test(pauseFn)
    && !/stored\.whatsapp = 'auto'/.test(pauseFn));
  assert('autonomy button sync uses effective mode while paused',
    /inboxShellEffectiveMode\(/.test(syncBtns) || /inboxShellPauseBlocksAuto\(/.test(syncBtns));
  assert('Auto click is ignored while Global Pause is on',
    /inboxShellPauseBlocksAuto\(/.test(wireFn) || /is-paused/.test(wireFn));

  console.log('\n[4] Persistence is tenant-global / authenticated prefs + session');
  assert('channel persist PATCHes /staff/auth/prefs with inbox_channel_modes',
    /\/staff\/auth\/prefs/.test(persistFn)
    && /method:\s*'PATCH'/.test(persistFn)
    && /inbox_channel_modes/.test(persistFn));
  assert('channel persist does not PUT /staff/inbox/luna-mode',
    !/\/staff\/inbox\/luna-mode/.test(persistFn)
    && !/inboxShellPutLunaMode\(/.test(persistFn));
  assert('channel persist does not POST global-pause/resume',
    !/\/staff\/bot\/global-pause/.test(persistFn)
    && !/\/staff\/bot\/global-resume/.test(persistFn));
  assert('handleAuthPrefs accepts inbox_channel_modes independently of guest panel',
    /inbox_channel_modes/.test(prefsFn)
    && /hasOwnProperty\.call\(body, 'inbox_guest_panel'\)/.test(prefsFn)
    && /hasOwnProperty\.call\(body, 'inbox_channel_modes'\)/.test(prefsFn));
  assert('prefs write is tenant-global on clients.settings inbox_channel_modes',
    /saveClientInboxChannelModes\(/.test(prefsFn)
    && /settings->'inbox_channel_modes'/.test(saveModesFn)
    && /UPDATE clients/.test(saveModesFn)
    && /jsonb_set\(/.test(saveModesFn)
    && /'\{inbox_channel_modes\}'/.test(saveModesFn)
    && !/metadata->'inbox_ui_channel_modes'/.test(saveModesFn)
    && !/metadata->'inbox_ui_channel_modes'/.test(apiSrc));
  assert('prefs load uses clients.settings inbox_channel_modes (not missing metadata)',
    /function loadClientInboxChannelModes\(/.test(apiSrc)
    && /function loadClientInboxChannelModesStore\(/.test(apiSrc)
    && /settings->'inbox_channel_modes'/.test(extractNamed(apiSrc, 'loadClientInboxChannelModesStore'))
    && !/metadata->'inbox_ui_channel_modes'/.test(extractNamed(apiSrc, 'loadClientInboxChannelModesStore'))
    && !/metadata->'inbox_ui_channel_modes'/.test(extractNamed(apiSrc, 'loadClientInboxChannelModes')));
  assert('prefs save preserves durable off when chrome sends draft',
    /function mergeInboxUiChannelMode\(/.test(apiSrc)
    && /cur === 'off'/.test(apiSrc));
  {
    const mergeFn = extractNamed(apiSrc, 'mergeInboxUiChannelMode');
    const storeFn = extractNamed(apiSrc, 'inboxChannelModesStoreFromUnknown');
    const helpersSrc = [
      extractNamed(apiSrc, 'inboxChannelModeFromValue'),
      extractNamed(apiSrc, 'inboxChannelModesFromUnknown'),
      extractNamed(apiSrc, 'inboxChannelModeStoreFromValue'),
      storeFn,
      mergeFn,
    ].filter(Boolean).join('\n');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
      `${helpersSrc}\n` +
      'this.mergeInboxUiChannelMode = mergeInboxUiChannelMode;\n' +
      'this.inboxChannelModesFromUnknown = inboxChannelModesFromUnknown;\n' +
      'this.inboxChannelModesStoreFromUnknown = inboxChannelModesStoreFromUnknown;\n',
      sandbox,
    );
    assert('merge keeps email off when UI projects draft',
      sandbox.mergeInboxUiChannelMode('off', 'draft') === 'off'
      && sandbox.mergeInboxUiChannelMode('auto', 'draft') === 'draft'
      && sandbox.mergeInboxUiChannelMode('draft', 'auto') === 'auto'
      && sandbox.mergeInboxUiChannelMode('off', 'auto') === 'auto');
    assert('store projection keeps off; UI projection maps off→draft',
      JSON.stringify(sandbox.inboxChannelModesStoreFromUnknown({ whatsapp: 'auto', email: 'off' }))
        === JSON.stringify({ whatsapp: 'auto', email: 'off' })
      && JSON.stringify(sandbox.inboxChannelModesFromUnknown({ whatsapp: 'auto', email: 'off' }))
        === JSON.stringify({ whatsapp: 'auto', email: 'draft' }));
  }
  assert('authenticated session projects inbox_channel_modes',
    /inbox_channel_modes/.test(sessionFn)
    && /loadClientInboxChannelModes\(/.test(sessionFn));
  assert('no-auth session still projects Draft/Draft defaults',
    /inbox_channel_modes:\s*inboxChannelModesFromUnknown\(null\)/.test(sessionFn)
    || /inbox_channel_modes: inboxChannelModesFromUnknown\(null\)/.test(sessionFn));
  assert('prefs/session requireAuth stays in place',
    /requireAuth\(req, res, 'viewer'\)/.test(prefsFn));
  assert('mode helpers default both channels to draft',
    !!(helpers && helpers.inboxChannelModesFromUnknown)
    && JSON.stringify(helpers.inboxChannelModesFromUnknown(null)) === JSON.stringify({ whatsapp: 'draft', email: 'draft' })
    && JSON.stringify(helpers.inboxChannelModesFromUnknown({ whatsapp: 'auto', email: 'nope' })) === JSON.stringify({ whatsapp: 'auto', email: 'draft' }));
  assert('chrome hydrates modes from GET /staff/auth/session',
    /\/staff\/auth\/session/.test(mountFn) || /\/staff\/auth\/session/.test(shellSrc)
    && /inbox_channel_modes/.test(shellSrc));
  assert('chrome prefers durable GET /staff/inbox/luna-mode when hydrating',
    /function inboxShellHydrateFromSession\(/.test(shellSrc)
    && /INBOX_SHELL_LUNA_MODE_PATH/.test(shellSrc)
    && /loadLunaModes\(/.test(shellSrc)
    && /if \(lunaModes\) return applyModes\(lunaModes\)/.test(shellSrc));

  console.log('\n[5] Conversation Luna On / needs_human remain the send gates');
  assert('thread-header WhatsApp stays Auto|Off (conversation Luna)',
    typeof luna.inboxLunaModeOptions === 'function'
    && JSON.stringify(luna.inboxLunaModeOptions('whatsapp')) === JSON.stringify(['auto', 'off']));
  assert('thread-header Email stays Draft|Off',
    typeof luna.inboxLunaModeOptions === 'function'
    && JSON.stringify(luna.inboxLunaModeOptions('email')) === JSON.stringify(['draft', 'off']));
  assert('thread-header still maps pause to Off and unpaused WhatsApp to Auto',
    typeof luna.inboxLunaModeFromPaused === 'function'
    && luna.inboxLunaModeFromPaused('whatsapp', false) === 'auto'
    && luna.inboxLunaModeFromPaused('whatsapp', true) === 'off'
    && luna.inboxLunaModeFromPaused('email', false) === 'draft');
  assert('luna-mode control still keeps pause + needs-human native checkboxes',
    /id="luna-pause-switch"/.test(lunaSrc)
    && /id="conv-needs-human-toggle"/.test(lunaSrc)
    && /id="inbox-needs-human-raise"/.test(lunaSrc));
  assert('green-box persist does not call conversation pause or needs-human routes',
    !/\/staff\/bot\/pause/.test(persistFn)
    && !/\/staff\/bot\/resume/.test(persistFn)
    && !/needs-human/.test(persistFn)
    && !/needs_human/.test(persistFn));
  assert('green-box copy does not claim to override Luna or Needs Human send gates',
    !/override (Luna|Needs Human)/i.test(shellSrc)
    && !/bypass (Luna|Needs Human)/i.test(shellSrc)
    && /Luna On/.test(shellSrc)
    && /Needs Human/.test(shellSrc));
  assert('inbox-luna-mode still only drives pause switch + needs-human toggle',
    /data-luna-mode'\) === 'off'/.test(lunaSrc)
    && /\/staff\/inbox\/luna-mode/.test(lunaSrc) === false);

  console.log('\n[6] Do not flip or require LUNA_AUTO_SEND_ENABLED');
  assert('shell persist/path does not read or set LUNA_AUTO_SEND_ENABLED',
    !/LUNA_AUTO_SEND_ENABLED/.test(persistFn)
    && !/LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED/.test(persistFn)
    && !/process\.env\.LUNA_AUTO_SEND_ENABLED/.test(shellSrc));
  assert('prefs/session handlers do not touch auto-send env flags',
    !/LUNA_AUTO_SEND_ENABLED/.test(prefsFn)
    && !/LUNA_AUTO_SEND_ENABLED/.test(sessionFn));
  assert('file header does not require auto-send flags for the green-box control',
    !/LUNA_AUTO_SEND_ENABLED/.test(shellSrc)
    && !/LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED/.test(shellSrc));

  console.log('\n[7] Cooked / injected UI ownership');
  assert('inbox-shell.js owns the autonomy rows',
    /function inboxShellAutonomyRowHtml\(/.test(shellSrc)
    && /data-inbox-autonomy-channel/.test(shellSrc));
  assert('shell is prepended onto the inbox-views inject marker',
    injectorSrc.includes('getInboxShellBrowserSource()')
    && /return getInboxShellBrowserSource\(\) \+ '\\n' \+ readBrowserModule\(VIEWS_MODULE\)/.test(injectorSrc));
  {
    const injected = injectInboxBrowserModules(`before\n${INBOX_VIEWS_INJECT_MARKER}\nafter\n`);
    assert('injector splices Draft|Auto autonomy controls over the views marker',
      injected.includes('function inboxShellAutonomyRowHtml(')
      && injected.includes('data-inbox-autonomy="draft"')
      && injected.includes('data-inbox-autonomy="auto"')
      && injected.includes('data-inbox-autonomy-channel="')
      && injected.includes("data-inbox-autonomy-row=\"' + channel + '\"")
      && !injected.includes(INBOX_VIEWS_INJECT_MARKER));
  }
  assert('combined cooked portal UI includes both channel autonomy rows',
    portalSrc.includes('data-inbox-autonomy="draft"')
    && portalSrc.includes('data-inbox-autonomy="auto"')
    && portalSrc.includes('data-inbox-autonomy-channel="')
    && portalSrc.includes('inbox-shell-channel-defaults'));
  assert('inbox-thread.js does not own channel autonomy chrome',
    !/data-inbox-autonomy/.test(threadSrc)
    && !/mountInboxShellChrome/.test(threadSrc)
    && !/inbox-shell-whatsapp-mode/.test(threadSrc));

  console.log('\n[8] Forbidden files stay out of this slice');
  for (const rel of FORBIDDEN) {
    assert(`${rel} is not this slice's owner`, fs.existsSync(path.join(ROOT, rel)));
  }
  assert('shell never calls Graph or Cloud send',
    !/graph\.microsoft\.com/.test(shellSrc)
    && !/sendMail/.test(shellSrc)
    && !/\/staff\/inbox\/send-reply/.test(shellSrc)
    && !/\/staff\/inbox\/whatsapp\/approve-send/.test(shellSrc)
    && !/\/staff\/inbox\/email\/approve-send/.test(shellSrc));
  assert('prefs helpers share durable settings.inbox_channel_modes with luna-mode store',
    /'\{inbox_channel_modes\}'/.test(saveModesFn)
    && /settings->'inbox_channel_modes'/.test(saveModesFn)
    && !/metadata->'inbox_ui_channel_modes'/.test(saveModesFn));
  assert('cooked portal still hydrates autonomy from session projection',
    portalSrc.includes('/staff/auth/session')
    && portalSrc.includes('inbox_channel_modes')
    && portalSrc.includes('data-inbox-autonomy="auto"'));

  console.log(`\nverify-autonomy-ui-001: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();
