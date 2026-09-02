'use strict';

/**
 * verify:inbox-thread-markdown
 *
 * Hernan Inbox defect: Luna outbound stored as WhatsApp/markdown
 * (`**Felix**`, `**€315 payment link**`) rendered as raw asterisks in Staff Inbox.
 *
 * Staff Inbox must safely render supported **bold** and markdown/bare links
 * without interpreting arbitrary HTML.
 *
 * Offline: extracts production renderer from scripts/browser/inbox-list.js.
 * No network, no WhatsApp send.
 *
 * Run: node scripts/verify-inbox-thread-markdown.js
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LIST_MODULE = path.join(ROOT, 'scripts', 'browser', 'inbox-list.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG_PATH = path.join(ROOT, 'package.json');

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing from inbox-list.js');
  let i = start;
  let depth = 0;
  let started = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) { i += 1; break; }
    }
  }
  return source.slice(start, i);
}

function loadRenderer() {
  const source = fs.readFileSync(LIST_MODULE, 'utf8');
  const stubs = {
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };
  const code = [
    extractFn(source, 'inboxThreadMessageBodyText'),
    extractFn(source, 'inboxThreadMessageSubjectText'),
    extractFn(source, 'formatInboxMarkdownHtml'),
    extractFn(source, 'formatInboxThreadBubbleHtml'),
  ].join('\n');
  const sandbox = { ...stubs, Object, String, RegExp };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

function assertNoRawHtmlInjection(html) {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img\s/i);
  assert.doesNotMatch(html, /href=["']javascript:/i);
}

(async () => {
  console.log('verify:inbox-thread-markdown');

  const listSrc = fs.readFileSync(LIST_MODULE, 'utf8');
  assert.match(listSrc, /function formatInboxMarkdownHtml\(/);
  assert.match(listSrc, /formatInboxMarkdownHtml\(body/);

  const portal = loadRenderer();
  const fmt = (text) => portal.formatInboxMarkdownHtml(text);
  const bubble = (text) => portal.formatInboxThreadBubbleHtml({
    direction: 'outbound',
    source: 'hermes_luna_whatsapp_reply',
    message_text: text,
  });

  const hernanBoldName = fmt("You're booked **Felix** for Saturday.");
  assert.match(hernanBoldName, /<strong>Felix<\/strong>/);
  assert.doesNotMatch(hernanBoldName, /\*\*Felix\*\*/);
  assert.match(hernanBoldName, /You(?:&#39;|'|&apos;)?re booked /);

  const hernanPay = fmt('Here is the **€315 payment link**.');
  assert.match(hernanPay, /<strong>€315 payment link<\/strong>/);
  assert.doesNotMatch(hernanPay, /\*\*€315 payment link\*\*/);

  const bubbleHtml = bubble("You're booked **Felix**. Here is the **€315 payment link**.");
  assert.match(bubbleHtml, /<strong>Felix<\/strong>/);
  assert.match(bubbleHtml, /<strong>€315 payment link<\/strong>/);

  const mdLink = fmt('Pay here: [€315 payment link](https://staff-staging.lunafrontdesk.com/pay/SUNSET-TEST)');
  assert.match(mdLink, /class="msg-link"/);
  assert.match(mdLink, /href="https:\/\/staff-staging\.lunafrontdesk\.com\/pay\/SUNSET-TEST"/);
  assert.match(mdLink, />€315 payment link</);
  assert.doesNotMatch(mdLink, /\[€315 payment link\]/);

  const bare = fmt('Pay https://staff-staging.lunafrontdesk.com/pay/ABC please');
  assert.match(bare, /class="msg-link"/);
  assert.match(bare, /href="https:\/\/staff-staging\.lunafrontdesk\.com\/pay\/ABC"/);

  const payHost = fmt('Use staff-staging.lunafrontdesk.com/pay/XYZ');
  assert.match(payHost, /class="msg-link"/);
  assert.match(payHost, /href="https:\/\/staff-staging\.lunafrontdesk\.com\/pay\/XYZ"/);

  const xss = fmt('<script>alert(1)</script> **<img src=x onerror=alert(1)>**');
  assert.match(xss, /&lt;script&gt;/);
  assert.doesNotMatch(xss, /<script>/i);
  assert.match(xss, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
  assertNoRawHtmlInjection(xss);

  const jsUrl = fmt('Click [here](javascript:alert(1)) please');
  assert.doesNotMatch(jsUrl, /href="/);
  assert.match(jsUrl, /javascript:alert\(1\)/);
  assertNoRawHtmlInjection(jsUrl);

  const httpJs = fmt('Go to javascript:alert(1)');
  assert.doesNotMatch(httpJs, /href="/);

  assert.equal(fmt(''), '');
  assert.equal(fmt('Hello WhatsApp'), 'Hello WhatsApp');
  assert.match(fmt('**unclosed'), /\*\*unclosed/);

  const apiSrc = fs.readFileSync(API_PATH, 'utf8');
  assert.match(apiSrc, /\.msg-bubble \.msg-link/);
  assert.doesNotMatch(listSrc, /innerHTML\s*=\s*body/);

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  assert.equal(
    pkg.scripts['verify:inbox-thread-markdown'],
    'node scripts/verify-inbox-thread-markdown.js',
  );

  console.log('PASS inbox-thread-markdown');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
