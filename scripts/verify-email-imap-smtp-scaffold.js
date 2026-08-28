'use strict';

/**
 * EMAIL-IMAP-001 — IMAP/SMTP scaffolding gate.
 *
 * Pure offline checks: no network, no DB, no provider SDKs, no secrets.
 * PASSES on fixtures. SKIPS the live IMAP/SMTP checks when secrets are absent
 * (they always are in CI/scaffold). Never opens a socket. Never a false pass:
 * live SKIP is reported explicitly and does not count as PASS.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IMAP_REL = 'scripts/lib/email-imap-inbound-scaffold.js';
const SMTP_REL = 'scripts/lib/email-smtp-outbound-scaffold.js';
const DOC_REL = 'docs/EMAIL-IMAP-SMTP-SCAFFOLD-BOUNDARY.md';
const VERIFY_SCRIPT_REL = 'scripts/verify-email-imap-smtp-scaffold.js';
const PKG_PATH = path.join(ROOT, 'package.json');

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name, detail ? `— ${detail}` : ''); }
}
function skipped(name, reason) {
  skip += 1;
  console.log('  SKIP ', name, reason ? `— ${reason}` : '');
}

console.log('verify:email-imap-smtp-scaffold — EMAIL-IMAP-001 IMAP/SMTP scaffolding\n');

// --- File presence ---
ok('IMAP helper exists', fs.existsSync(path.join(ROOT, IMAP_REL)), IMAP_REL);
ok('SMTP helper exists', fs.existsSync(path.join(ROOT, SMTP_REL)), SMTP_REL);
ok('boundary doc exists', fs.existsSync(path.join(ROOT, DOC_REL)), DOC_REL);

// --- package.json wiring ---
let pkg = null;
try { pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')); } catch { pkg = null; }
ok('package.json parses', pkg != null);
ok('has verify:email-imap-smtp-scaffold script',
  Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-imap-smtp-scaffold']));
ok('verify script points at this verifier',
  Boolean(pkg && pkg.scripts && String(pkg.scripts['verify:email-imap-smtp-scaffold'] || '').includes(VERIFY_SCRIPT_REL)));

// --- Scope guard: new files must not import out-of-scope subsystems ---
const imapSrc = fs.readFileSync(path.join(ROOT, IMAP_REL), 'utf8');
const smtpSrc = fs.readFileSync(path.join(ROOT, SMTP_REL), 'utf8');
const FORBIDDEN_IMPORT = /require\((['"]).*?(graph|gmail|google|microsoft|key-?vault|keyvault|mailbridge|inbox-thread|inbox-context|skipper).*?\1\)/i;
ok('IMAP helper imports nothing out-of-scope', !FORBIDDEN_IMPORT.test(imapSrc));
ok('SMTP helper imports nothing out-of-scope', !FORBIDDEN_IMPORT.test(smtpSrc));
// No require() of any real network client at all (transports are injected).
ok('IMAP helper has no top-level provider client require', !/require\((['"])(imap|imapflow|node-imap|nodemailer)\1\)/i.test(imapSrc));
ok('SMTP helper has no top-level provider client require', !/require\((['"])(nodemailer|smtp-connection)\1\)/i.test(smtpSrc));

const imap = require(path.join(ROOT, IMAP_REL));
const smtp = require(path.join(ROOT, SMTP_REL));

// --- IMAP fail-closed on missing secrets ---
(function () {
  const r = imap.resolveImapConfig({});
  ok('IMAP unconfigured with empty env', r.configured === false);
  ok('IMAP reports all three missing keys',
    Array.isArray(r.missing) && ['IMAP_HOST','IMAP_USER','IMAP_PASSWORD'].every((k) => r.missing.includes(k)));
  const partial = imap.resolveImapConfig({ IMAP_HOST: 'imap.example.com', IMAP_USER: 'u' });
  ok('IMAP still fail-closed with password missing',
    partial.configured === false && partial.missing.includes('IMAP_PASSWORD'));
})();

// --- IMAP configures with fixture secrets (no connect) ---
(function () {
  const r = imap.resolveImapConfig({
    IMAP_HOST: 'imap.example.com', IMAP_USER: 'staff@example.com', IMAP_PASSWORD: 'fixture-pass',
  });
  ok('IMAP configures with all secrets', r.configured === true);
  ok('IMAP default port 993 + TLS on', r.configured && r.config.port === 993 && r.config.tls === true);
  ok('IMAP default mailbox INBOX', r.configured && r.config.mailbox === 'INBOX');
})();

// --- IMAP idempotency / dedupe via injected fake transport (offline) ---
(async function () {
  const fixtureRows = [
    { messageId: '<a1@example.com>', from: 'guest@x.com', subject: 'Hi', receivedAt: '2026-08-14T10:00:00Z', uid: 1 },
    { messageId: '<a1@example.com>', from: 'guest@x.com', subject: 'Hi (dup)', receivedAt: '2026-08-14T10:00:00Z', uid: 1 },
    { messageId: 'a2@example.com', from: 'g2@x.com', subject: 'Yo', receivedAt: '2026-08-14T11:00:00Z', uid: 2 },
    { messageId: 'not a message id', from: 'bad', subject: 'x' },
  ];
  const res = await imap.fetchInbound({
    env: { IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASSWORD: 'p' },
    transportFetch: () => fixtureRows,
  });
  ok('IMAP fetch ok with fake transport', res.ok === true);
  ok('IMAP dedupes by Message-ID', res.ok && res.messages.length === 2 && res.skippedDuplicates === 1);
  ok('IMAP dedupeKey is stable + namespaced',
    res.ok && res.messages[0].dedupeKey === 'imap_smtp:INBOX:a1@example.com');
  ok('IMAP drops rows without usable Message-ID', res.ok && !res.messages.some((m) => m.subject === 'x'));

  const noCfg = await imap.fetchInbound({ env: {}, transportFetch: () => [] });
  ok('IMAP fetch refuses when unconfigured', noCfg.ok === false && noCfg.reason === 'imap_not_configured');
  const noTransport = await imap.fetchInbound({ env: { IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASSWORD: 'p' } });
  ok('IMAP fetch refuses with no transport injected', noTransport.ok === false && noTransport.reason === 'no_transport_injected');
})();

// --- SMTP fail-closed on missing secrets ---
(function () {
  const r = smtp.resolveSmtpConfig({});
  ok('SMTP unconfigured with empty env', r.configured === false);
  ok('SMTP reports all three missing keys',
    Array.isArray(r.missing) && ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD'].every((k) => r.missing.includes(k)));
})();

// --- SMTP configures + validates + sends via fake transport (offline) ---
(async function () {
  const env = { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'staff@example.com', SMTP_PASSWORD: 'fixture-pass' };
  const cfg = smtp.resolveSmtpConfig(env);
  ok('SMTP configures with all secrets', cfg.configured === true);
  ok('SMTP default port 587 + STARTTLS on', cfg.configured && cfg.config.port === 587 && cfg.config.starttls === true);
  ok('SMTP from defaults to user', cfg.configured && cfg.config.from === 'staff@example.com');

  ok('SMTP rejects invalid to address', smtp.validateStaffReply({ to: 'nope', text: 'hi' }).ok === false);
  ok('SMTP rejects empty body', smtp.validateStaffReply({ to: 'g@x.com', text: '   ' }).ok === false);

  let captured = null;
  const res = await smtp.sendStaffReply({
    env,
    reply: { to: 'guest@x.com', subject: 'Re: Hi', text: 'Thanks!', inReplyTo: '<a1@example.com>' },
    transportSend: (config, message) => { captured = { config, message }; return { accepted: [message.to] }; },
  });
  ok('SMTP send ok with fake transport', res.ok === true && res.result && res.result.accepted[0] === 'guest@x.com');
  ok('SMTP passes one validated message to transport',
    captured && captured.message.to === 'guest@x.com' && captured.message.inReplyTo === '<a1@example.com>');

  const noCfg = await smtp.sendStaffReply({ env: {}, reply: { to: 'g@x.com', text: 'x' }, transportSend: () => ({}) });
  ok('SMTP send refuses when unconfigured', noCfg.ok === false && noCfg.reason === 'smtp_not_configured');
  const noTransport = await smtp.sendStaffReply({ env, reply: { to: 'g@x.com', text: 'x' } });
  ok('SMTP send refuses with no transport injected', noTransport.ok === false && noTransport.reason === 'no_transport_injected');
})();

// --- Live checks: SKIP when secrets absent; never a false pass ---
(function () {
  const imapLive = imap.IMAP_ENV_KEYS.every((k) => process.env[k] && String(process.env[k]).trim() !== '');
  if (!imapLive) skipped('live IMAP connect', 'IMAP_HOST/IMAP_USER/IMAP_PASSWORD not set (no live connect tonight)');
  else skipped('live IMAP connect', 'secrets present but scaffold performs no live connect by design');

  const smtpLive = smtp.SMTP_ENV_KEYS.every((k) => process.env[k] && String(process.env[k]).trim() !== '');
  if (!smtpLive) skipped('live SMTP send', 'SMTP_HOST/SMTP_USER/SMTP_PASSWORD not set (auto-send off, no live send)');
  else skipped('live SMTP send', 'secrets present but scaffold performs no live send by design');
})();

// Give async IHEs a tick to flush before summary.
setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}, 50);
