'use strict';

/**
 * SMTP send transport: STARTTLS AUTH then MAIL FROM / RCPT TO / DATA / QUIT.
 * Health-only verifySession stays in email-sunset-smtp-starttls-transport.
 * Inject sendImpl in tests. No live send from MAIL-MVP-006 proofs.
 */

const net = require('node:net');
const tls = require('node:tls');
const {
  createSunsetSmtpStarttlsTransport,
  hasStarttlsCapability,
  assertSameResponseCode,
} = require('./email-sunset-smtp-starttls-transport');

const TIMEOUT_MS = 10000;
const EHLO_NAME = 'lunafrontdesk.com';
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function result(ok, failed) {
  const out = { ok: ok === true };
  if (failed) out.failed_secret_names = Object.freeze(failed.slice());
  return Object.freeze(out);
}

function asciiSafe(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 320
    && ADDRESS_RE.test(value) && !/[\r\n]/.test(value);
}

function headerSafe(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
    && !/[\r\n]/.test(value);
}

function createSunsetSmtpSendTransport(deps = {}) {
  const netModule = deps.netModule || net;
  const tlsConnect = deps.tlsConnect || tls.connect.bind(tls);
  const sendImpl = typeof deps.sendImpl === 'function' ? deps.sendImpl : null;
  createSunsetSmtpStarttlsTransport({ netModule, tlsConnect });

  async function sendMail(credentials, envelope) {
    if (sendImpl) return sendImpl(credentials, envelope);
    let socket;
    let buffer = '';
    let waiter = null;
    const cleanupWaiter = () => { waiter = null; };
    function waitResponse() {
      return new Promise((resolve, reject) => {
        const lines = [];
        waiter = { resolve, reject, lines };
        consume();
      });
    }
    function consume() {
      if (!waiter) return;
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        waiter.lines.push(line);
        const match = /^(\d{3})([ -])/.exec(line);
        if (!match) {
          const current = waiter; cleanupWaiter(); current.reject(new Error('smtp_malformed_response')); return;
        }
        const expectedCode = /^(\d{3})/.exec(waiter.lines[0])[1];
        if (match[1] !== expectedCode) {
          const current = waiter; cleanupWaiter(); current.reject(new Error('smtp_multiline_code_mismatch')); return;
        }
        if (match[2] === ' ') {
          const current = waiter;
          cleanupWaiter();
          try { assertSameResponseCode(current.lines); }
          catch (err) { current.reject(err); return; }
          current.resolve({ code: Number(match[1]), lines: current.lines });
          return;
        }
      }
    }
    function attach(s) {
      s.on('data', (chunk) => { buffer += chunk.toString('utf8'); consume(); });
      s.on('error', (err) => { if (waiter) { const w = waiter; cleanupWaiter(); w.reject(err); } });
      s.setTimeout(TIMEOUT_MS, () => s.destroy(new Error('smtp_timeout')));
    }
    function command(text) { socket.write(`${text}\r\n`); return waitResponse(); }
    try {
      if (!credentials || credentials.tlsMode !== 'starttls') return result(false, ['sunset-smtp-tls-mode']);
      if (typeof credentials.host !== 'string' || !credentials.host || !Number.isInteger(credentials.port)
          || credentials.port < 1 || credentials.port > 65535) return result(false, ['sunset-smtp-host']);
      if (!envelope || !asciiSafe(envelope.from) || !asciiSafe(envelope.to)) return result(false, ['sunset-smtp-host']);
      if (!headerSafe(envelope.subject || 'Re: your message', 200)) return result(false, ['sunset-smtp-host']);
      if (typeof envelope.text !== 'string' || envelope.text.length < 1 || envelope.text.length > 64000) {
        return result(false, ['sunset-smtp-host']);
      }
      socket = netModule.createConnection({ host: credentials.host, port: credentials.port });
      attach(socket);
      const greeting = await waitResponse();
      if (greeting.code !== 220) return result(false, ['sunset-smtp-host']);
      const hello = await command(`EHLO ${EHLO_NAME}`);
      if (hello.code !== 250 || !hasStarttlsCapability(hello.lines)) return result(false, ['sunset-smtp-tls-mode']);
      if ((await command('STARTTLS')).code !== 220) return result(false, ['sunset-smtp-tls-mode']);
      socket.removeAllListeners('data');
      buffer = '';
      socket = tlsConnect({ socket, servername: credentials.host, rejectUnauthorized: true });
      attach(socket);
      await new Promise((resolve, reject) => {
        if (socket.encrypted === true && socket.authorized !== undefined) {
          socket.once('secureConnect', resolve); socket.once('error', reject);
        } else resolve();
      });
      if ((await command(`EHLO ${EHLO_NAME}`)).code !== 250) return result(false, ['sunset-smtp-host']);
      const auth = Buffer.from(`\u0000${credentials.username}\u0000${credentials.password}`, 'utf8').toString('base64');
      const authReply = await command(`AUTH PLAIN ${auth}`);
      if (authReply.code !== 235) {
        try { await command('QUIT'); } catch (_) { /* best effort */ }
        return result(false, ['sunset-smtp-password']);
      }
      if ((await command(`MAIL FROM:<${envelope.from}>`)).code !== 250) return result(false, ['sunset-smtp-host']);
      if ((await command(`RCPT TO:<${envelope.to}>`)).code !== 250) return result(false, ['sunset-smtp-host']);
      if ((await command('DATA')).code !== 354) return result(false, ['sunset-smtp-host']);
      const subject = envelope.subject || 'Re: your message';
      const dotted = envelope.text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      socket.write(`From: <${envelope.from}>\r\nTo: <${envelope.to}>\r\nSubject: ${subject}\r\n\r\n${dotted}\r\n.\r\n`);
      const dataReply = await waitResponse();
      if (dataReply.code !== 250) return result(false, ['sunset-smtp-host']);
      const quit = await command('QUIT');
      return quit.code === 221 ? result(true) : result(false, ['sunset-smtp-host']);
    } catch (_) {
      return result(false, ['sunset-smtp-host']);
    } finally {
      if (socket && !socket.destroyed) socket.destroy();
    }
  }

  return Object.freeze({ sendMail });
}

module.exports = Object.freeze({ createSunsetSmtpSendTransport });
