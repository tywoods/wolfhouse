#!/usr/bin/env node
'use strict';

/**
 * verify:inbox-theme
 *
 * Offline gate for Inbox mockup slice C — cream / forest / sage visual tokens.
 *
 * Proves:
 *   - theme CSS is injected from inbox-shell.js (sibling #inbox-mockup-theme-style
 *     or the existing #inbox-shell-channel-defaults-style), no new inject marker
 *   - every theme rule is scoped under #inbox-shell or #tab-conversations
 *   - no naked body { background ... } restyle
 *   - cream / forest / sage (or --cream plus a forest/sage var) appear in the CSS
 *   - .inbox-views-group-label gets small-caps or letter-spacing
 *   - .inbox-views-item.is-active is styled
 *   - slice A channel-pill selectors still exist
 *   - inbox-thread.js and staff-query-api.js are not modified by this slice
 *
 * No database, no network, no browser.
 *
 * Run: node scripts/verify-inbox-theme.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  SHELL_MODULE,
  THREAD_MODULE,
  CONTEXT_MODULE,
  VIEWS_MODULE,
  INBOX_VIEWS_INJECT_MARKER,
  getInboxShellBrowserSource,
  injectInboxBrowserModules,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const LUNA_ALL_PATH = path.join(ROOT, 'scripts', 'verify-luna-all.js');
const INJECTOR_PATH = path.join(ROOT, 'scripts', 'lib', 'inbox-browser-source.js');

const shellSrc = fs.readFileSync(SHELL_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const lunaAllSrc = fs.readFileSync(LUNA_ALL_PATH, 'utf8');
const injectorSrc = fs.readFileSync(INJECTOR_PATH, 'utf8');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function gitPorcelain(relPath) {
  try {
    return execSync(`git status --porcelain -- ${relPath}`, {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch (_e) {
    return 'git-error';
  }
}

function gitDiffAgainstHead(relPath) {
  try {
    return execSync(`git diff HEAD -- ${relPath}`, {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (_e) {
    return 'git-error';
  }
}

function loadShellCssFns() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${shellSrc}\n` +
    'this.inboxMockupThemeCssText = inboxMockupThemeCssText;\n' +
    'this.inboxShellCssText = inboxShellCssText;\n' +
    'this.INBOX_MOCKUP_THEME_STYLE_ID = INBOX_MOCKUP_THEME_STYLE_ID;\n' +
    'this.INBOX_SHELL_STYLE_ID = INBOX_SHELL_STYLE_ID;\n',
    sandbox,
  );
  return sandbox;
}

function themeRuleSelectors(css) {
  const stripped = String(css || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const selectors = [];
  let buf = '';
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      const sel = buf.trim();
      if (sel && !sel.startsWith('@')) selectors.push(sel);
      buf = '';
    } else if (ch === '}') {
      buf = '';
    } else {
      buf += ch;
    }
  }
  return selectors;
}

function selectorIsScoped(selector) {
  return String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => /#inbox-shell\b/.test(part) || /#tab-conversations\b/.test(part));
}

function labelRuleCss(css) {
  const stripped = String(css || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const re = /#(?:inbox-shell|tab-conversations)\b[^{]*\.inbox-views-group-label[^{]*\{([^}]*)\}/g;
  let match;
  let body = '';
  while ((match = re.exec(stripped))) body += match[1];
  return body;
}

console.log('\nverify:inbox-theme — cream/forest visual tokens (mockup slice C)\n');

console.log('── injection ──');
ok('inbox-shell.js exists', fs.existsSync(SHELL_MODULE));
ok('theme style id is inbox-mockup-theme-style (sibling of channel-defaults)',
  /INBOX_MOCKUP_THEME_STYLE_ID = 'inbox-mockup-theme-style'/.test(shellSrc)
  && /INBOX_SHELL_STYLE_ID = 'inbox-shell-channel-defaults-style'/.test(shellSrc));
ok('mount still injects both style tags from inbox-shell.js',
  /function inboxMockupThemeCssText\(/.test(shellSrc)
  && /function inboxMockupThemeEnsureStyle\(/.test(shellSrc)
  && /inboxMockupThemeEnsureStyle\(\)/.test(shellSrc)
  && /function inboxShellEnsureStyle\(/.test(shellSrc)
  && /inboxShellEnsureStyle\(\)/.test(shellSrc));
ok('no new inject marker; theme rides the existing views marker via shell',
  injectorSrc.includes('getInboxShellBrowserSource()')
  && !injectorSrc.includes('INJECT:inbox-theme')
  && !apiSrc.includes('INJECT:inbox-theme')
  && apiSrc.includes(INBOX_VIEWS_INJECT_MARKER));
{
  const injected = injectInboxBrowserModules(`before\n${INBOX_VIEWS_INJECT_MARKER}\nafter\n`);
  ok('injector still splices shell (theme CSS fn) over the views marker',
    injected.includes('function inboxMockupThemeCssText(')
    && injected.includes('inbox-mockup-theme-style')
    && injected.includes('function inboxShellCssText(')
    && injected.includes('function inboxSavedViewsUrl(')
    && !injected.includes(INBOX_VIEWS_INJECT_MARKER));
}
ok('getInboxShellBrowserSource includes the theme CSS function',
  getInboxShellBrowserSource().includes('function inboxMockupThemeCssText('));

console.log('\n── scoped tokens ──');
const fns = loadShellCssFns();
ok('theme CSS function is executable', typeof fns.inboxMockupThemeCssText === 'function');
const themeCss = typeof fns.inboxMockupThemeCssText === 'function' ? fns.inboxMockupThemeCssText() : '';
const shellCss = typeof fns.inboxShellCssText === 'function' ? fns.inboxShellCssText() : '';
ok('theme CSS is non-empty', themeCss.length > 80);

ok('no naked body { background restyle in theme CSS',
  !/(^|})\s*body\s*\{[^}]*background/i.test(themeCss.replace(/\/\*[\s\S]*?\*\//g, ' '))
  && !/(^|})\s*html\s*\{[^}]*background/i.test(themeCss.replace(/\/\*[\s\S]*?\*\//g, ' ')));
ok('theme CSS does not restyle the staff nav / tabs bar',
  !/#tabs\b/.test(themeCss)
  && !/\.tab-btn\b/.test(themeCss)
  && !/#banner\b/.test(themeCss)
  && !/wavy/.test(themeCss));

const selectors = themeRuleSelectors(themeCss);
ok('theme CSS has scoped rules', selectors.length >= 6, `got ${selectors.length} selectors`);
{
  const unscoped = selectors.filter((sel) => !selectorIsScoped(sel));
  ok('every theme rule is under #inbox-shell or #tab-conversations',
    unscoped.length === 0,
    unscoped.length ? unscoped.slice(0, 5).join(' | ') : '');
}

ok('cream appears (--cream or cream paper)',
  /--cream\b/.test(themeCss) || /\bcream\b/i.test(themeCss));
ok('forest appears (--inbox-forest or forest)',
  /--inbox-forest\b/.test(themeCss) || /\bforest\b/i.test(themeCss));
ok('sage appears (--sage / --inbox-sage)',
  /--inbox-sage\b/.test(themeCss) || /--sage\b/.test(themeCss) || /\bsage\b/i.test(themeCss));
ok('Inbox-only tokens are declared on #inbox-shell',
  /#inbox-shell\{[^}]*--inbox-paper:var\(--cream\)/.test(themeCss.replace(/\s+/g, ''))
  || /#inbox-shell\{[\s\S]*--inbox-forest:/.test(themeCss));

console.log('\n── rail + guest card + pills ──');
{
  const labelBody = labelRuleCss(themeCss);
  ok('.inbox-views-group-label gets small-caps or letter-spacing',
    /font-variant\s*:\s*small-caps/i.test(labelBody)
    || /letter-spacing\s*:/.test(labelBody),
    labelBody ? `body=${labelBody.slice(0, 80)}` : 'no label rule');
}
ok('.inbox-views-item.is-active is styled (filled forest row)',
  /#inbox-shell\s+\.inbox-views-item\.is-active\{/.test(themeCss)
  && /--inbox-forest/.test(themeCss));
ok('guest card / column 4 sits on paper, not a bulky grey stack',
  /#inbox-guest-card/.test(themeCss)
  && /\.inbox-guest-card/.test(themeCss)
  && /--inbox-paper/.test(themeCss));
ok('zero-count guest sections stay dimmed in sage',
  /\.inbox-guest-section\.is-zero/.test(themeCss)
  && /--inbox-sage/.test(themeCss));

ok('slice A channel pill selectors still exist',
  /\.inbox-shell-channel\{/.test(shellCss)
  && /\.inbox-shell-channel-select\{/.test(shellCss)
  && /border-radius:999px/.test(shellCss)
  && /data-inbox-shell-channel/.test(shellSrc)
  && /class="inbox-shell-channel-select"/.test(shellSrc)
  && /inbox-shell-' \+ channel \+ '-mode"/.test(shellSrc));
ok('theme restyles those pills without dropping the slice A classes',
  /#tab-conversations\s+\.inbox-shell-channel\{/.test(themeCss)
  && /#tab-conversations\s+\.inbox-shell-channel-select\{/.test(themeCss)
  && /border-radius:var\(--radius-pill,999px\)/.test(themeCss));
ok('hides Conversations|Customers switch, Reset/Wipe toolbar, and per-row Luna pills',
  /#tab-conversations \.inbox-view-switch\{display:none!important\}/.test(themeCss)
  && /#tab-conversations \.detail-conv-toolbar\{display:none!important\}/.test(themeCss)
  && /#inbox-shell \.conv-card-pills/.test(themeCss)
  && /#inbox-shell \.conv-card-delete/.test(themeCss));

console.log('\n── stay off ──');
ok('inbox-thread.js is not modified (git)',
  gitPorcelain('scripts/browser/inbox-thread.js') === ''
  && gitDiffAgainstHead('scripts/browser/inbox-thread.js') === '');
ok('inbox-thread.js source has no theme CSS / guest-card rewrite',
  !/inbox-mockup-theme-style/.test(threadSrc)
  && !/inboxMockupThemeCssText/.test(threadSrc)
  && !/--inbox-forest/.test(threadSrc)
  && /function renderInboxConvCardHtml\(/.test(threadSrc)
  && /function loadConvDetail\(/.test(threadSrc));
ok('staff-query-api.js is not modified by this slice (git)',
  gitPorcelain('scripts/staff-query-api.js') === ''
  && gitDiffAgainstHead('scripts/staff-query-api.js') === '');
ok('staff-query-api.js has no new theme CSS block pasted into the template',
  !/inbox-mockup-theme-style/.test(apiSrc)
  && !/--inbox-forest/.test(apiSrc)
  && !/--inbox-paper/.test(apiSrc)
  && !/inboxMockupThemeCssText/.test(apiSrc)
  && !/INJECT:inbox-theme/.test(apiSrc));
ok('Customers tab, Pause Luna Globally, Reset Luna, Full Wipe stay in the portal',
  /nav\.tab\.customers/.test(apiSrc)
  && /data-view="customers"/.test(apiSrc)
  && /Pause Luna Globally/.test(apiSrc)
  && /Reset Luna session/.test(threadSrc)
  && /Full Wipe/.test(threadSrc));
ok('views rail still renders API groups — theme styles labels, does not invent groups',
  fs.readFileSync(VIEWS_MODULE, 'utf8').includes('inbox-views-group-label')
  && fs.readFileSync(VIEWS_MODULE, 'utf8').includes('inbox-views-item')
  && !/<div class="inbox-views-group-label">/.test(shellSrc));
ok('inbox-context.js guest-card renderer is not rewritten by this slice',
  fs.readFileSync(CONTEXT_MODULE, 'utf8').includes('function inboxContextGuestCardHtml(')
  && !/--inbox-forest/.test(fs.readFileSync(CONTEXT_MODULE, 'utf8')));
ok('package.json and luna-all register this gate',
  pkg.scripts && pkg.scripts['verify:inbox-theme'] === 'node scripts/verify-inbox-theme.js'
  && /verify-inbox-theme\.js/.test(lunaAllSrc)
  && /verify:inbox-theme/.test(lunaAllSrc));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-theme — FAILED');
  process.exit(1);
}
console.log('verify:inbox-theme — ALL CHECKS PASSED');
process.exit(0);
