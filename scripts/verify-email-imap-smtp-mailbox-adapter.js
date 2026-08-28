'use strict';

/**
 * EMAIL-IMAP-002 — Fail-closed IMAP/SMTP mailbox adapter gate.
 *
 * Pure offline checks: no network, no DB, no provider SDKs, no secrets.
 * PASSES on fixtures. SKIPS live IMAP/SMTP when IMAP_ and SMTP_ secrets are absent.
 * Never opens a socket. No false pass: live SKIP is explicit, never counts as PASS.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADAPTER_REL = 'scripts/lib/email-imap-smtp-mailbox-adapter.js';
const VERIFY_SCRIPT_REL = 'scripts/verify-email-imap-smtp-mailbox-adapter.js';
const PKG_PATH = path.join(ROOT, 'package.json');

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name, detail ? `— ${detail}` : ''); }
}
function skipped(name, reason) { skip += 1; console.log('  SKIP ', name, reason ? `— ${reason}` : ''); }

console.log('verify:email-imap-smtp-mailbox-adapter — EMAIL-IMAP-002 fail-closed adapter\n');

// --- File presence + wiring ---
ok('adapter exists', fs.existsSync(path.join(ROOT, ADAPTER_REL)), ADAPTER_REL);
let pkg = null;
try { pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')); } catch { pkg = null; }
ok('package.json parses', pkg != null);
ok('has verify:email-imap-smtp-mailbox-adapter script',
  Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-imap-smtp-mailbox-adapter']));
ok('verify script points at this verifier',
  Boolean(pkg && pkg.scripts && String(pkg.scripts['verify:email-imap-smtp-mailbox-adapter'] || '').includes(VERIFY_SCRIPT_REL)));

// --- Scope guard: adapter must not import out-of-scope subsystems ---
const src = fs.readFileSync(path.join(ROOT, ADAPTER_REL), 'utf8');
const FORBIDDEN = /require\((['"]).*?(graph|gmail|google|microsoft|key-?vault|keyvault|mailbridge|inbox-thread|inbox-context|skipper|delta-poller).*?\1\)/i;
ok('adapter imports nothing out-of-scope', !FORBIDDEN.test(src));
ok('adapter has no real network client require',
  !/require\((['"])(imap|imapflow|node-imap|nodemailer|smtp-connection)\1\)/i.test(src));
ok('adapter implements the mailbox adapter contract',
  /require\((['"])\.\/email-mailbox-adapter-contract\1\)/.test(src)
  && /validateEmailMailboxAdapterIdentity/.test(src));

const { createImapSmtpMailboxAdapter, PROVIDER } = require(path.join(ROOT, ADAPTER_REL));
ok('adapter provider is imap_smtp', PROVIDER === 'imap_smtp');

const CAPS = Object.freeze({
  push_notifications: false, provider_threads: false, remote_drafts: false,
  reply: true, reply_all: false, forward: false,
  attachments_metadata: false, delivery_events: false,
});

// --- Identity fail-closed (contract enforced) ---
(function () {
  const bad = createImapSmtpMailboxAdapter({ public_address: 'not-an-email', capabilities: CAPS });
  ok('rejects invalid public_address', bad.ok === false);
  const noCaps = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: null });
  ok('rejects missing capabilities', noCaps.ok === false);
  const good = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: CAPS });
  ok('builds with valid identity', good.ok === true);
  ok('describe() reports imap_smtp + address', good.ok
    && good.adapter.describe().provider === 'imap_smtp'
    && good.adapter.describe().public_address === 'desk@example.com');
  ok('supports(reply) true, supports(forward) false', good.ok
    && good.adapter.supports('reply') === true && good.adapter.supports('forward') === false);
  let threw = false;
  try { good.ok && good.adapter.supports('bogus'); } catch { threw = true; }
  ok('supports() throws on unknown capability', threw);
})();

// --- Readiness fail-closed without secrets ---
(function () {
  const a = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: CAPS, env: {} },
    { transportFetch: () => [], transportSend: () => ({}) });
  ok('inboundReady false without IMAP secrets', a.ok && a.adapter.inboundReady() === false);
  ok('outboundReady false without SMTP secrets', a.ok && a.adapter.outboundReady() === false);
})();

// --- Readiness needs both config AND transport ---
(function () {
  const env = {
    IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASSWORD: 'p',
    SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASSWORD: 'p',
  };
  const noTransport = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: CAPS, env });
  ok('inboundReady false with config but no transport', noTransport.ok && noTransport.adapter.inboundReady() === false);
  ok('outboundReady false with config but no transport', noTransport.ok && noTransport.adapter.outboundReady() === false);
  const withT = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: CAPS, env },
    { transportFetch: () => [], transportSend: () => ({}) });
  ok('inboundReady true with config + transport', withT.ok && withT.adapter.inboundReady() === true);
  ok('outboundReady true with config + transport + reply cap', withT.ok && withT.adapter.outboundReady() === true);
})();

// --- Outbound refused when reply capability not advertised ---
(async function () {
  const noReplyCaps = { ...CAPS, reply: false };
  const env = { SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASSWORD: 'p' };
  const a = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: noReplyCaps, env },
    { transportSend: () => ({}) });
  ok('outboundReady false when reply cap off', a.ok && a.adapter.outboundReady() === false);
  const r = await a.adapter.sendReply({ to: 'g@x.com', subject: 'x', text: 'hi' });
  ok('sendReply refused when reply cap off', r.ok === false && r.reason === 'reply_capability_not_advertised');
})();

// --- Functional inbound/outbound via injected fakes (offline) ---
(async function () {
  const env = {
    IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASSWORD: 'p',
    SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASSWORD: 'p',
  };
  const rows = [
    { messageId: '<m1@x.com>', from: 'g@x.com', subject: 'Hi', receivedAt: '2026-08-14T10:00:00Z', uid: 1 },
    { messageId: '<m1@x.com>', from: 'g@x.com', subject: 'dup', receivedAt: '2026-08-14T10:00:00Z', uid: 1 },
  ];
  let sent = null;
  const a = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: CAPS, env },
    { transportFetch: () => rows, transportSend: (cfg, msg) => { sent = msg; return { accepted: [msg.to] }; } });
  const inb = await a.adapter.fetchInbound();
  ok('adapter fetchInbound dedupes by Message-ID', inb.ok && inb.messages.length === 1 && inb.skippedDuplicates === 1);
  const out = await a.adapter.sendReply({ to: 'g@x.com', subject: 'Re: Hi', text: 'Thanks!', inReplyTo: '<m1@x.com>' });
  ok('adapter sendReply ok via fake transport', out.ok === true && out.result.accepted[0] === 'g@x.com');
  ok('adapter passes one validated reply', sent && sent.to === 'g@x.com' && sent.inReplyTo === '<m1@x.com>');
  const bad = await a.adapter.sendReply({ to: 'nope', text: 'x' });
  ok('adapter sendReply rejects invalid reply', bad.ok === false);
})();

// --- Live checks: SKIP without secrets; never a false pass ---
(function () {
  const imapLive = ['IMAP_HOST','IMAP_USER','IMAP_PASSWORD'].every((k) => process.env[k] && String(process.env[k]).trim() !== '');
  skipped('live IMAP connect', imapLive ? 'secrets present but adapter performs no live connect by design' : 'IMAP_* not set (no live connect)');
  const smtpLive = ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD'].every((k) => process.env[k] && String(process.env[k]).trim() !== '');
  skipped('live SMTP send', smtpLive ? 'secrets present but adapter performs no live send by design' : 'SMTP_* not set (auto-send off)');
})();

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}, 50);
