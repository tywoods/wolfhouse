'use strict';

/**
 * IMAP health/fetch transport: implicit TLS (port 993) with certificate
 * validation and SNI. Verify allowlist: greeting, CAPABILITY, LOGIN,
 * SELECT INBOX, LOGOUT. Fetch additionally: UID SEARCH, UID FETCH.
 * No SMTP, APPEND, STORE, COPY, or send.
 *
 * @module email-sunset-imap-imaps-transport
 */

const tls = require('node:tls');

const TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 131072;
const MAX_LINE = 8192;
const MAX_LITERAL = 65536 + 8192;
const IMAP_PORT = 993;
const IMAP_TLS_MODE = 'imaps';
const IMAP_VERIFY_COMMANDS = Object.freeze(['CAPABILITY', 'LOGIN', 'SELECT', 'LOGOUT']);
const IMAP_FETCH_MAX_MESSAGES = 5;

function result(ok, failed, extra) {
  const out = Object.assign({ ok: ok === true }, extra || {});
  if (failed) out.failed_secret_names = Object.freeze(failed.slice());
  return Object.freeze(out);
}

function quoteImapString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function assertSameImapTag(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected !== actual) {
    throw new Error('imap_tag_mismatch');
  }
  return actual;
}

function parseStatusLine(line) {
  if (typeof line !== 'string') return null;
  if (line.startsWith('* ')) {
    return Object.freeze({ kind: 'untagged', text: line.slice(2) });
  }
  if (line.startsWith('+')) {
    return Object.freeze({ kind: 'continuation', text: line.slice(1).trim() });
  }
  const match = /^(\S+)\s+(OK|NO|BAD)(?:\s+(.*))?$/i.exec(line);
  if (!match) return null;
  return Object.freeze({
    kind: 'tagged',
    tag: match[1],
    status: match[2].toUpperCase(),
    text: match[3] || '',
  });
}

function parseSearchUids(untagged) {
  const uids = [];
  for (let i = 0; i < untagged.length; i += 1) {
    const match = /^SEARCH(?:\s+(.*))?$/i.exec(untagged[i]);
    if (!match) continue;
    const rest = match[1] ? match[1].trim() : '';
    if (!rest) continue;
    const parts = rest.split(/\s+/);
    for (let j = 0; j < parts.length; j += 1) {
      const uid = Number(parts[j]);
      if (!Number.isInteger(uid) || uid < 1) throw new Error('imap_malformed_response');
      uids.push(uid);
    }
  }
  return uids;
}

function parseUidvalidity(untagged) {
  for (let i = 0; i < untagged.length; i += 1) {
    const match = /\[UIDVALIDITY\s+(\d+)\]/i.exec(untagged[i]);
    if (match) {
      const value = Number(match[1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('imap_malformed_response');
      return value;
    }
  }
  return null;
}

function parseFetchMessage(item, uidvalidity) {
  const raw = item && item.text;
  if (typeof raw !== 'string' || !/\bFETCH\b/i.test(raw)) {
    return null;
  }
  const uidMatch = /\bUID\s+(\d+)/i.exec(raw);
  if (!uidMatch) return null;
  const uid = Number(uidMatch[1]);
  if (!Number.isInteger(uid) || uid < 1) return null;
  const flagsMatch = /\bFLAGS\s+\(([^)]*)\)/i.exec(raw);
  const flags = flagsMatch && flagsMatch[1].trim()
    ? flagsMatch[1].trim().split(/\s+/).filter(Boolean)
    : [];
  const dateMatch = /\bINTERNALDATE\s+"([^"]+)"/i.exec(raw);
  let headersText = '';
  let bodyText = '';
  const captures = Array.isArray(item.captures) ? item.captures : [];
  for (let i = 0; i < captures.length; i += 1) {
    const cap = captures[i];
    if (!cap || typeof cap.before !== 'string') continue;
    if (/HEADER\.FIELDS/i.test(cap.before)) headersText = cap.data;
    else if (/BODY\[TEXT\]/i.test(cap.before)) bodyText = cap.data;
  }
  const headers = {};
  const lines = String(headersText || '').split(/\r\n/);
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (current && /^[ \t]/.test(line)) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    current = line.slice(0, idx).trim().toLowerCase();
    headers[current] = line.slice(idx + 1).trim();
  }
  return Object.freeze({
    uid,
    uidvalidity,
    flags: Object.freeze(flags.slice()),
    internalDate: dateMatch ? dateMatch[1] : '',
    headers: Object.freeze(headers),
    bodyText: typeof bodyText === 'string' ? bodyText : '',
  });
}

function createSunsetImapImapsTransport(deps = {}) {
  const tlsConnect = deps.tlsConnect || tls.connect.bind(tls);

  async function openSession(credentials) {
    if (!credentials || credentials.tlsMode !== IMAP_TLS_MODE) {
      throw Object.assign(new Error('imap_tls_mode'), { failedName: 'sunset-imap-tls-mode' });
    }
    if (typeof credentials.host !== 'string' || !credentials.host) {
      throw Object.assign(new Error('imap_host'), { failedName: 'sunset-imap-host' });
    }
    if (!Number.isInteger(credentials.port) || credentials.port !== IMAP_PORT) {
      throw Object.assign(new Error('imap_port'), { failedName: 'sunset-imap-port' });
    }

    let socket;
    let buffer = '';
    let totalBytes = 0;
    let waiter = null;
    let tagSeq = 0;

    function cleanupWaiter() { waiter = null; }

    function failWait(err) {
      if (!waiter) return;
      const current = waiter;
      cleanupWaiter();
      current.reject(err);
    }

    function tryReadLogicalLine() {
      const buf = buffer;
      let i = 0;
      let text = '';
      const captures = [];
      while (i <= buf.length) {
        const crlf = buf.indexOf('\r\n', i);
        if (crlf < 0) return null;
        const physical = buf.slice(i, crlf);
        if (physical.length > MAX_LINE) throw new Error('imap_malformed_response');
        const lit = /\{(\d+)\+?\}$/.exec(physical);
        if (!lit) {
          text += physical;
          buffer = buf.slice(crlf + 2);
          return { text, captures };
        }
        const n = Number(lit[1]);
        if (!Number.isInteger(n) || n < 0 || n > MAX_LITERAL) throw new Error('imap_oversized_response');
        const dataStart = crlf + 2;
        if (buf.length < dataStart + n) return null;
        const before = physical.slice(0, physical.length - lit[0].length);
        const data = Buffer.from(buf.slice(dataStart, dataStart + n), 'latin1').toString('utf8');
        captures.push({ before, data });
        text += before + data;
        i = dataStart + n;
      }
      return null;
    }

    function pump() {
      if (!waiter) return;
      try {
        const line = tryReadLogicalLine();
        if (!line) return;
        const current = waiter;
        cleanupWaiter();
        current.resolve(line);
      } catch (err) {
        failWait(err);
      }
    }

    function readLine() {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        try { pump(); } catch (err) { failWait(err); }
      });
    }

    function nextTag() {
      tagSeq += 1;
      return `A${String(tagSeq).padStart(4, '0')}`;
    }

    async function waitTagged(expectedTag) {
      const untagged = [];
      const fetchItems = [];
      for (;;) {
        const line = await readLine();
        const parsed = parseStatusLine(line.text);
        if (!parsed) throw new Error('imap_malformed_response');
        if (parsed.kind === 'untagged') {
          untagged.push(parsed.text);
          if (/FETCH\b/i.test(parsed.text)) fetchItems.push(line);
          continue;
        }
        if (parsed.kind === 'continuation') throw new Error('imap_malformed_response');
        assertSameImapTag(expectedTag, parsed.tag);
        return Object.freeze({
          status: parsed.status,
          text: parsed.text,
          untagged: Object.freeze(untagged.slice()),
          fetchItems: Object.freeze(fetchItems.slice()),
        });
      }
    }

    function command(text) {
      const tag = nextTag();
      socket.write(`${tag} ${text}\r\n`);
      return waitTagged(tag);
    }

    socket = tlsConnect({
      host: credentials.host,
      port: credentials.port,
      servername: credentials.host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('imap_timeout')));
    socket.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        failWait(new Error('imap_oversized_response'));
        socket.destroy();
        return;
      }
      buffer += chunk.toString('latin1');
      pump();
    });
    socket.on('error', (err) => failWait(err));
    socket.on('end', () => failWait(new Error('imap_closed')));

    await new Promise((resolve, reject) => {
      const onSecure = () => { socket.removeListener('error', onErr); resolve(); };
      const onErr = (err) => { socket.removeListener('secureConnect', onSecure); reject(err); };
      if (socket.encrypted === true && socket.authorized !== undefined) {
        socket.once('secureConnect', onSecure);
        socket.once('error', onErr);
      } else {
        resolve();
      }
    });

    const greetingLine = await readLine();
    const greeting = parseStatusLine(greetingLine.text);
    if (!greeting || greeting.kind !== 'untagged' || !/^OK\b/i.test(greeting.text)) {
      throw new Error('imap_greeting');
    }

    const greetingCaps = /\[CAPABILITY\s+([^\]]+)\]/i.exec(greeting.text);
    if (!greetingCaps || !/\bIMAP4rev1\b/i.test(greetingCaps[1])) {
      const caps = await command('CAPABILITY');
      if (caps.status !== 'OK') throw new Error('imap_capability');
    }

    const login = await command(`LOGIN ${quoteImapString(credentials.username)} ${quoteImapString(credentials.password)}`);
    if (login.status !== 'OK') {
      try { await command('LOGOUT'); } catch (_) { /* best effort */ }
      throw Object.assign(new Error('imap_login'), { failedName: 'sunset-imap-password' });
    }

    const selected = await command('SELECT INBOX');
    if (selected.status !== 'OK') throw new Error('imap_select');
    const uidvalidity = parseUidvalidity(selected.untagged);

    return Object.freeze({
      command,
      uidvalidity,
      async logout() {
        try { await command('LOGOUT'); } catch (_) { /* best effort */ }
      },
      destroy() {
        if (socket && !socket.destroyed) socket.destroy();
      },
    });
  }

  async function verifySession(credentials) {
    let session;
    try {
      session = await openSession(credentials);
      await session.logout();
      return result(true);
    } catch (err) {
      const name = err && err.failedName;
      if (name === 'sunset-imap-password') return result(false, ['sunset-imap-password']);
      if (name === 'sunset-imap-tls-mode') return result(false, ['sunset-imap-tls-mode']);
      if (name === 'sunset-imap-port') return result(false, ['sunset-imap-port']);
      return result(false, ['sunset-imap-host']);
    } finally {
      if (session) session.destroy();
    }
  }

  async function fetchInbox(credentials, cursor) {
    let session;
    try {
      session = await openSession(credentials);
      const uidvalidity = session.uidvalidity;
      if (!Number.isInteger(uidvalidity) || uidvalidity < 1) {
        await session.logout();
        return result(false, ['sunset-imap-host']);
      }
      let lastUid = 0;
      if (cursor && Number(cursor.uidvalidity) === uidvalidity && Number.isInteger(Number(cursor.last_uid))) {
        lastUid = Number(cursor.last_uid);
        if (lastUid < 0) lastUid = 0;
      }
      const search = await session.command(`UID SEARCH UID ${lastUid + 1}:*`);
      if (search.status !== 'OK') {
        await session.logout();
        return result(false, ['sunset-imap-host']);
      }
      const uids = parseSearchUids(search.untagged).filter((uid) => uid > lastUid)
        .slice(0, IMAP_FETCH_MAX_MESSAGES);
      if (uids.length === 0) {
        await session.logout();
        return result(true, null, {
          uidvalidity,
          last_uid: lastUid,
          messages: Object.freeze([]),
        });
      }
      const spec = uids.length === 1 ? String(uids[0]) : `${uids[0]}:${uids[uids.length - 1]}`;
      const fetched = await session.command(
        `UID FETCH ${spec} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] BODY.PEEK[TEXT])`,
      );
      if (fetched.status !== 'OK') {
        await session.logout();
        return result(false, ['sunset-imap-host']);
      }
      const messages = [];
      for (let i = 0; i < fetched.fetchItems.length; i += 1) {
        const item = fetched.fetchItems[i];
        const parsed = parseFetchMessage({ text: item.text, captures: item.captures }, uidvalidity);
        if (!parsed) throw new Error('imap_malformed_response');
        messages.push(parsed);
      }
      await session.logout();
      const maxUid = messages.reduce((acc, msg) => (msg.uid > acc ? msg.uid : acc), lastUid);
      return result(true, null, {
        uidvalidity,
        last_uid: maxUid,
        messages: Object.freeze(messages.slice()),
      });
    } catch (err) {
      const name = err && err.failedName;
      if (name === 'sunset-imap-password') return result(false, ['sunset-imap-password']);
      if (name === 'sunset-imap-tls-mode') return result(false, ['sunset-imap-tls-mode']);
      if (name === 'sunset-imap-port') return result(false, ['sunset-imap-port']);
      return result(false, ['sunset-imap-host']);
    } finally {
      if (session) session.destroy();
    }
  }

  return Object.freeze({ verifySession, fetchInbox });
}

module.exports = Object.freeze({
  createSunsetImapImapsTransport,
  assertSameImapTag,
  IMAP_VERIFY_COMMANDS,
  IMAP_FETCH_MAX_MESSAGES,
  IMAP_PORT,
  IMAP_TLS_MODE,
});
