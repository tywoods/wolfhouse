'use strict';

/**
 * EMAIL-IMAP-003 — Fail-closed behavior tests (offline).
 *
 * Adversarial tests that assert the IMAP/SMTP scaffolds and adapter cannot touch
 * the network without secrets AND an injected transport, that auto-send stays
 * off, and that idempotency holds. Pure offline: no network, no DB, no provider
 * SDKs, no secrets. Live IMAP/SMTP checks SKIP when IMAP/SMTP env is absent.
 * No false pass.
 *
 * New file only. Does not modify or import inbox-thread.js.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IMAP_REL = 'scripts/lib/email-imap-inbound-scaffold.js';
const SMTP_REL = 'scripts/lib/email-smtp-outbound-scaffold.js';
const ADAPTER_REL = 'scripts/lib/email-imap-smtp-mailbox-adapter.js';
const VERIFY_SCRIPT_REL = 'scripts/verify-email-imap-003.js';
const PKG_PATH = path.join(ROOT, 'package.json');

let pass = Number(0);
let fail = Number(0);
let skip = Number(0);
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name, detail ? `— ${detail}` : ''); }
}
function skipped(name, reason) { skip += 1; console.log('  SKIP ', name, reason ? `— ${reason}` : ''); }

console.log('verify:email-imap-003 — EMAIL-IMAP-003 fail-closed behavior tests\n');

// --- Presence + wiring ---
ok('IMAP scaffold exists', fs.existsSync(path.join(ROOT, IMAP_REL)), IMAP_REL);
ok('SMTP scaffold exists', fs.existsSync(path.join(ROOT, SMTP_REL)), SMTP_REL);
ok('adapter exists', fs.existsSync(path.join(ROOT, ADAPTER_REL)), ADAPTER_REL);
let pkg = null;
try { pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')); } catch { pkg = null; }
ok('has verify:email-imap-003 script',
  Boolean(pkg && pkg.scripts && String(pkg.scripts['verify:email-imap-003'] || '').includes(VERIFY_SCRIPT_REL)));

// --- New scaffold/adapter files must not REQUIRE the forbidden inbox module ---
// Guard on actual require() edges, not prose: scope-guard docstrings name the
// forbidden modules deliberately, so a raw text scan would false-fail.
const FORBIDDEN_MODULE = ['inbox', 'thread'].join('-');
function requiresForbidden(source) {
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m[1].includes(FORBIDDEN_MODULE)) return true;
  }
  return false;
}
const noForbiddenRequire = [IMAP_REL, SMTP_REL, ADAPTER_REL].every((rel) =>
  !requiresForbidden(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
ok('scaffolds/adapter do not require the forbidden inbox module', noForbiddenRequire);

const imap = require(path.join(ROOT, IMAP_REL));
const smtp = require(path.join(ROOT, SMTP_REL));
const { createImapSmtpMailboxAdapter } = require(path.join(ROOT, ADAPTER_REL));

const FULL_ENV = {
  IMAP_HOST: 'imap.example.com', IMAP_USER: 'u', IMAP_PASSWORD: '***',
  SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASSWORD: '***',
};
const CAPS = Object.freeze({
  push_notifications: false, provider_threads: false, remote_drafts: false,
  reply: true, reply_all: false, forward: false,
  attachments_metadata: false, delivery_events: false,
});

// A transport that FAILS the test if it is ever invoked — proves "no network".
let networkTouched = false;
function tripwireFetch() { networkTouched = true; throw new Error('network_touched_fetch'); }
function tripwireSend() { networkTouched = true; throw new Error('network_touched_send'); }

// --- No secrets: refuse BEFORE any transport is called ---
(async function () {
  const inb = await imap.fetchInbound({ env: {}, transportFetch: tripwireFetch });
  ok('IMAP refuses without secrets and never calls transport',
    inb.ok === false && inb.reason === 'imap_not_configured');
  const out = await smtp.sendStaffReply({ env: {}, reply: { to: 'g@x.com', text: 'x' }, transportSend: tripwireSend });
  ok('SMTP refuses without secrets and never calls transport',
    out.ok === false && out.reason === 'smtp_not_configured');
  ok('tripwire transports never fired on unconfigured calls', networkTouched === false);
})();

// --- Secrets present but NO transport injected: still no network ---
(async function () {
  const inb = await imap.fetchInbound({ env: FULL_ENV });
  ok('IMAP with secrets but no transport = no_transport_injected',
    inb.ok === false && inb.reason === 'no_transport_injected');
  const out = await smtp.sendStaffReply({ env: FULL_ENV, reply: { to: 'g@x.com', text: 'x' } });
  ok('SMTP with secrets but no transport = no_transport_injected',
    out.ok === false && out.reason === 'no_transport_injected');
})();

// --- Adapter fails closed identically ---
(async function () {
  const a = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: CAPS, env: {} },
    { transportFetch: tripwireFetch, transportSend: tripwireSend });
  const inb = await a.adapter.fetchInbound();
  ok('adapter fetchInbound refuses without secrets', inb.ok === false && inb.reason === 'imap_not_configured');
  const out = await a.adapter.sendReply({ to: 'g@x.com', subject: 's', text: 'hi' });
  ok('adapter sendReply refuses without secrets', out.ok === false && out.reason === 'smtp_not_configured');
})();

// --- Auto-send off: sending is single, explicit, and returns after one message ---
(async function () {
  let sendCount = 0;
  const a = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: CAPS, env: FULL_ENV },
    { transportFetch: () => [], transportSend: (cfg, msg) => { sendCount += 1; return { accepted: [msg.to] }; } });
  const r1 = await a.adapter.sendReply({ to: 'g@x.com', subject: 'Re', text: 'hi' });
  ok('adapter sendReply sends exactly one message', r1.ok === true && sendCount === 1);
  // No public method exists to batch/loop/auto-send — assert the surface.
  const methods = Object.keys(a.adapter);
  const forbidden = methods.filter((m) => /auto|batch|loop|drain|flush|poll|enableSend|startSend/i.test(m));
  ok('adapter exposes no auto-send/batch/loop method', forbidden.length === 0, forbidden.join(','));
  // Source-level: no setInterval/setTimeout scheduling in scaffolds/adapter.
  const noTimers = [IMAP_REL, SMTP_REL, ADAPTER_REL].every((rel) =>
    !/set(Interval|Timeout)\s*\(/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  ok('no timer-driven scheduling in scaffolds/adapter', noTimers);
})();

// --- Idempotency holds across repeated fetches (same dedupeKey) ---
(async function () {
  const rows = [
    { messageId: '<dup@x.com>', from: 'g@x.com', subject: 'A', receivedAt: '2026-08-15T00:00:00Z', uid: 1 },
    { messageId: '<dup@x.com>', from: 'g@x.com', subject: 'B', receivedAt: '2026-08-15T00:00:00Z', uid: 1 },
    { messageId: '<other@x.com>', from: 'g@x.com', subject: 'C', receivedAt: '2026-08-15T01:00:00Z', uid: 2 },
  ];
  const a = createImapSmtpMailboxAdapter({ public_address: 'desk@example.com', capabilities: CAPS, env: FULL_ENV },
    { transportFetch: () => rows, transportSend: () => ({}) });
  const first = await a.adapter.fetchInbound();
  const second = await a.adapter.fetchInbound();
  ok('repeated fetch yields identical dedupeKeys', first.ok && second.ok
    && JSON.stringify(first.messages.map((m) => m.dedupeKey))
       === JSON.stringify(second.messages.map((m) => m.dedupeKey)));
  ok('in-batch duplicates dropped, distinct kept', first.ok
    && first.messages.length === 2 && first.skippedDuplicates === 1);
})();

// --- Live checks SKIP without secrets; no false pass ---
(function () {
  const imapLive = ['IMAP_HOST','IMAP_USER','IMAP_PASSWORD'].every((k) => process.env[k] && String(process.env[k]).trim() !== '');
  skipped('live IMAP connect', imapLive ? 'secrets present but no live connect by design' : 'IMAP env absent (no network)');
  const smtpLive = ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD'].every((k) => process.env[k] && String(process.env[k]).trim() !== '');
  skipped('live SMTP send', smtpLive ? 'secrets present but no live send by design' : 'SMTP env absent (auto-send off)');
})();

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}, 60);
