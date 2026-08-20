'use strict';

/** SMTP health transport: EHLO, STARTTLS, EHLO, AUTH PLAIN, QUIT only. */
const net = require('node:net');
const tls = require('node:tls');

const TIMEOUT_MS = 10000;
const EHLO_NAME = 'lunafrontdesk.com';

function result(ok, failed) {
  const out = { ok: ok === true };
  if (failed) out.failed_secret_names = Object.freeze(failed.slice());
  return Object.freeze(out);
}

function createSunsetSmtpStarttlsTransport(deps = {}) {
  const netModule = deps.netModule || net;
  const tlsConnect = deps.tlsConnect || tls.connect.bind(tls);

  async function verifySession(credentials) {
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
        if (match && match[2] === ' ') {
          const current = waiter;
          cleanupWaiter();
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
      socket = netModule.createConnection({ host: credentials.host, port: credentials.port });
      attach(socket);
      const greeting = await waitResponse();
      if (greeting.code !== 220) return result(false, ['sunset-smtp-host']);
      const hello = await command(`EHLO ${EHLO_NAME}`);
      if (hello.code !== 250 || !hello.lines.some((line) => /STARTTLS/i.test(line))) return result(false, ['sunset-smtp-tls-mode']);
      if ((await command('STARTTLS')).code !== 220) return result(false, ['sunset-smtp-tls-mode']);
      socket.removeAllListeners('data');
      buffer = '';
      socket = tlsConnect({ socket, servername: credentials.host, rejectUnauthorized: true });
      attach(socket);
      await new Promise((resolve, reject) => {
        if (socket.encrypted === true && socket.authorized !== undefined) {
          socket.once('secureConnect', resolve); socket.once('error', reject);
        } else resolve(); // injected test upgrade
      });
      if ((await command(`EHLO ${EHLO_NAME}`)).code !== 250) return result(false, ['sunset-smtp-host']);
      const auth = Buffer.from(`\u0000${credentials.username}\u0000${credentials.password}`, 'utf8').toString('base64');
      const authReply = await command(`AUTH PLAIN ${auth}`);
      if (authReply.code !== 235) {
        try { await command('QUIT'); } catch (_) { /* best effort */ }
        return result(false, ['sunset-smtp-password']);
      }
      const quit = await command('QUIT');
      return quit.code === 221 ? result(true) : result(false, ['sunset-smtp-host']);
    } catch (_) {
      return result(false, ['sunset-smtp-host']);
    } finally {
      if (socket && !socket.destroyed) socket.destroy();
    }
  }
  return Object.freeze({ verifySession });
}

module.exports = Object.freeze({ createSunsetSmtpStarttlsTransport });
