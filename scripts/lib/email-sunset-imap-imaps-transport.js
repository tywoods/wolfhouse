'use strict';

/**
 * IMAP health/fetch transport: implicit TLS (port 993) with certificate
 * validation and SNI. Verify allowlist: greeting, CAPABILITY, LOGIN,
 * SELECT INBOX, LOGOUT. Fetch additionally: bounded UID SEARCH, UID FETCH.
 * SEARCH ranges are always finite numeric windows (never `start:*`).
 * Fetch is a bounded BODYSTRUCTURE/RFC822.SIZE preflight plus
 * BODY.PEEK[section]<offset.count> of a selected text/plain part.
 * Production never requests a full-message empty-section BODY.PEEK.
 * Selected-section 7BIT remains US-ASCII except a bounded Gmail
 * normalization: when BODYSTRUCTURE charset is explicit UTF-8/UTF8 and
 * the complete selected literal is fatal-UTF-8-valid, raw high-bit
 * octets are accepted. RFC MIME 7BIT decodeTransfer is unchanged.
 * No SMTP, APPEND, STORE, COPY, or send.
 *
 * @module email-sunset-imap-imaps-transport
 */

const tls = require('node:tls');
const {
  parseRawHeaders,
  decodeTransfer,
  decodeCharset,
  inferCharset,
  MAX_HEADER_BLOCK,
} = require('./email-imap-rfc822-safe-text');
const {
  parseImapBodystructure,
  selectSafeTextPlainPart,
  formatBodyPeekSection,
  isValidImapSection,
} = require('./email-imap-bodystructure');
const { EMAIL_INBOUND_BODY_TEXT_MAX } = require('./email-inbound-envelope-contract');

const TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 131072;
const MAX_LINE = 8192;
const MAX_LITERAL = 65536 + 8192;
const IMAP_PORT = 993;
const IMAP_TLS_MODE = 'imaps';
const IMAP_VERIFY_COMMANDS = Object.freeze(['CAPABILITY', 'LOGIN', 'SELECT', 'LOGOUT']);
const IMAP_FETCH_MAX_MESSAGES = 5;
const IMAP_UID_MIN = 1;
const IMAP_UID_MAX = 4294967295;
const IMAP_LAST_UID_MIN = 0;
// Maximum inclusive numeric width of one UID SEARCH range. Never unbounded `*`.
// Dense 10-digit UIDs in this window stay well under MAX_RESPONSE_BYTES.
const IMAP_SEARCH_MAX_WINDOW = 1024;
const IMAP_CREDENTIAL_MAX = 256;
const IMAP_CAPABILITY_MAX_ATOMS = 64;
const IMAP_HEADER_FETCH_MAX = MAX_HEADER_BLOCK;
const IMAP_FETCH_BATCH_MAX_BYTES = MAX_RESPONSE_BYTES;
const IMAP_PROHIBITED_CONTROLS = /[\u0000-\u001F\u007F]/;
const IMAP_PRINTABLE_ASCII = /^[\u0020-\u007E]+$/;
const IMAP_UNSIGNED_DECIMAL = /^(0|[1-9][0-9]{0,9})$/;
const IMAP_ATOM_RE = /^[^\x00-\x20\x7f(){%*"\\\]]+$/;
const IMAP_PREFLIGHT_ATTRS = `(UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]<0.${IMAP_HEADER_FETCH_MAX}>)`;

function result(ok, failed, extra) {
  const out = Object.assign({ ok: ok === true }, extra || {});
  if (failed) out.failed_secret_names = Object.freeze(failed.slice());
  return Object.freeze(out);
}

function parseUnsignedDecimal(raw) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || !Number.isSafeInteger(raw)) return null;
    return raw;
  }
  if (typeof raw === 'string') {
    if (!IMAP_UNSIGNED_DECIMAL.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) return null;
    return value;
  }
  return null;
}

function parseRfcUid(raw) {
  const value = parseUnsignedDecimal(raw);
  if (value == null || value < IMAP_UID_MIN || value > IMAP_UID_MAX) return null;
  return value;
}

function parseRfcUidvalidity(raw) {
  return parseRfcUid(raw);
}

function parseRfcLastUid(raw) {
  const value = parseUnsignedDecimal(raw);
  if (value == null || value < IMAP_LAST_UID_MIN || value > IMAP_UID_MAX) return null;
  return value;
}

function parseRfcUidnext(raw) {
  return parseRfcUid(raw);
}

function parseSelectResponseCode(untagged, code) {
  if (!Array.isArray(untagged) || typeof code !== 'string' || !/^[A-Z]+$/.test(code)) {
    throw new Error('imap_malformed_response');
  }
  // Untagged payloads after "* ". Accept UIDNEXT/UIDVALIDITY only from
  // syntactically valid untagged status responses whose resp-text-code sits
  // immediately after the status atom, e.g. `OK [UIDNEXT 18] ...` /
  // `OK [UIDVALIDITY 9] ...` (wire: `* OK [UIDNEXT 18] ...`).
  //
  // NO, BAD, and PREAUTH are categorically rejected as mailbox-identity
  // sources even when they carry a leading UIDNEXT/UIDVALIDITY response
  // code. SELECT bounds must not be established from a failed or
  // greeting-class condition, nor from arbitrary EXISTS/FLAGS/human text.
  // Duplicate, conflicting, empty, or out-of-bounds values on accepted OK
  // lines still throw imap_malformed_response.
  const rawValues = [];
  const leading = new RegExp(`^OK \\[${code}(?: |\\])`, 'i');
  const extract = new RegExp(`\\[${code}(?:\\s+([^\\]]*))?\\]`, 'gi');
  for (let i = 0; i < untagged.length; i += 1) {
    const line = untagged[i];
    if (typeof line !== 'string') throw new Error('imap_malformed_response');
    if (!leading.test(line)) continue;
    extract.lastIndex = 0;
    let match = extract.exec(line);
    while (match) {
      rawValues.push(match[1] == null ? '' : match[1]);
      match = extract.exec(line);
    }
  }
  if (rawValues.length === 0) return null;
  if (rawValues.length > 1) throw new Error('imap_malformed_response');
  const value = parseRfcUid(rawValues[0]);
  if (value == null) throw new Error('imap_malformed_response');
  return value;
}

function parseUidvalidity(untagged) {
  return parseSelectResponseCode(untagged, 'UIDVALIDITY');
}

function parseUidnext(untagged) {
  return parseSelectResponseCode(untagged, 'UIDNEXT');
}

function addUidClamped(uid, delta) {
  const base = parseRfcLastUid(uid);
  if (base == null || !Number.isInteger(delta) || delta < 0) {
    throw new Error('imap_malformed_response');
  }
  const sum = base + delta;
  if (sum >= IMAP_UID_MAX) return IMAP_UID_MAX;
  return sum;
}

function boundedUidSearchRange(lastUid, uidnext) {
  const parsedLast = parseRfcLastUid(lastUid);
  const parsedNext = parseRfcUidnext(uidnext);
  if (parsedLast == null || parsedNext == null) throw new Error('imap_malformed_response');
  const highest = parsedNext - 1;
  if (parsedLast > highest) throw new Error('imap_malformed_response');
  if (highest < IMAP_UID_MIN) {
    return null;
  }
  if (parsedLast === IMAP_LAST_UID_MIN) {
    const end = highest;
    const start = end >= IMAP_FETCH_MAX_MESSAGES
      ? end - IMAP_FETCH_MAX_MESSAGES + 1
      : IMAP_UID_MIN;
    return Object.freeze({ start, end, bootstrap: true });
  }
  const start = parsedLast + 1;
  if (start > highest || start > IMAP_UID_MAX) return null;
  const windowEnd = addUidClamped(parsedLast, IMAP_SEARCH_MAX_WINDOW);
  const end = windowEnd < highest ? windowEnd : highest;
  if (start > end) return null;
  return Object.freeze({ start, end, bootstrap: false });
}

function formatBoundedUidSearchCommand(start, end) {
  const parsedStart = parseRfcUid(start);
  const parsedEnd = parseRfcUid(end);
  if (parsedStart == null || parsedEnd == null || parsedStart > parsedEnd) {
    throw new Error('imap_malformed_response');
  }
  const text = `UID SEARCH UID ${parsedStart}:${parsedEnd}`;
  if (text.includes('*') || /:\s*$/.test(text)) throw new Error('imap_malformed_response');
  return text;
}

function credentialFailed(name) {
  return Object.assign(new Error('imap_credential'), { failedName: name });
}

function assertSafeImapCredential(value, failedName) {
  if (typeof value !== 'string' || value.length < 1 || value.length > IMAP_CREDENTIAL_MAX) {
    throw credentialFailed(failedName);
  }
  if (IMAP_PROHIBITED_CONTROLS.test(value) || !IMAP_PRINTABLE_ASCII.test(value)) {
    throw credentialFailed(failedName);
  }
  return value;
}

function quoteImapString(value) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > IMAP_CREDENTIAL_MAX
      || IMAP_PROHIBITED_CONTROLS.test(value)
      || !IMAP_PRINTABLE_ASCII.test(value)) {
    throw new Error('imap_unsafe_quoted_string');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
      const uid = parseRfcUid(parts[j]);
      if (uid == null) throw new Error('imap_malformed_response');
      uids.push(uid);
    }
  }
  return uids;
}

function normalizeSearchUids(rawUids) {
  if (!Array.isArray(rawUids)) throw new Error('imap_malformed_response');
  const seen = new Set();
  const uids = [];
  for (let i = 0; i < rawUids.length; i += 1) {
    const uid = parseRfcUid(rawUids[i]);
    if (uid == null) throw new Error('imap_malformed_response');
    if (seen.has(uid)) continue;
    seen.add(uid);
    uids.push(uid);
  }
  uids.sort((a, b) => a - b);
  if (uids.length > IMAP_FETCH_MAX_MESSAGES) {
    return uids.slice(0, IMAP_FETCH_MAX_MESSAGES);
  }
  return uids;
}

function formatUidSequenceSet(uids) {
  if (!Array.isArray(uids) || uids.length < 1 || uids.length > IMAP_FETCH_MAX_MESSAGES) {
    throw new Error('imap_malformed_response');
  }
  const parts = [];
  const seen = new Set();
  for (let i = 0; i < uids.length; i += 1) {
    const uid = parseRfcUid(uids[i]);
    if (uid == null || seen.has(uid)) throw new Error('imap_malformed_response');
    seen.add(uid);
    parts.push(String(uid));
  }
  return parts.join(',');
}

function parseCapabilityAtomList(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return Object.freeze([]);
  if (/[^\S ]/.test(raw) || raw !== raw.trim() || raw.includes('  ')) return null;
  const parts = raw.split(' ');
  if (parts.length < 1 || parts.length > IMAP_CAPABILITY_MAX_ATOMS) return null;
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i] || !IMAP_ATOM_RE.test(parts[i])) return null;
  }
  return Object.freeze(parts.slice());
}

function capabilityHasExactImap4rev1(atoms) {
  if (!Array.isArray(atoms) || atoms.length < 1) return false;
  let count = 0;
  for (let i = 0; i < atoms.length; i += 1) {
    if (String(atoms[i]).toUpperCase() === 'IMAP4REV1') count += 1;
  }
  return count === 1;
}

function parseGreetingCapabilityAtoms(greetingText) {
  if (typeof greetingText !== 'string') return { present: false };
  const match = /\[CAPABILITY(?:\s+([^\]]*?))?\]/i.exec(greetingText);
  if (!match) return { present: false };
  const atoms = parseCapabilityAtomList(match[1] ? match[1].trim() : '');
  if (atoms == null) return { present: true, malformed: true };
  return { present: true, atoms };
}

function parseUntaggedCapabilityAtoms(untagged) {
  if (!Array.isArray(untagged)) return null;
  const hits = [];
  for (let i = 0; i < untagged.length; i += 1) {
    const line = untagged[i];
    if (typeof line !== 'string') return null;
    if (!/^CAPABILITY(?:\s|$)/i.test(line)) continue;
    hits.push(line);
  }
  if (hits.length !== 1) return null;
  const match = /^CAPABILITY(?:\s+(.*))?$/i.exec(hits[0]);
  if (!match) return null;
  return parseCapabilityAtomList(match[1] ? match[1] : '');
}

function requireExactImap4rev1FromCapability(untagged) {
  const atoms = parseUntaggedCapabilityAtoms(untagged);
  if (!capabilityHasExactImap4rev1(atoms)) {
    throw new Error('imap_capability');
  }
  return atoms;
}

function isFullMessageBodyCapture(before) {
  return typeof before === 'string' && /BODY(?:\.PEEK)?\[\]\s*$/i.test(before);
}

function isHeaderFieldsCapture(before) {
  return typeof before === 'string'
    && /BODY(?:\.PEEK)?\[HEADER(?:\.FIELDS \([^)]*\))?\](?:<0(?:\.\d+)?>)?\s*$/i.test(before);
}

function isSectionCapture(before, section) {
  if (typeof before !== 'string' || !isValidImapSection(section)) return false;
  const escaped = section.replace(/\./g, '\\.');
  const re = new RegExp(`BODY(?:\\.PEEK)?\\[${escaped}\\](?:<0(?:\\.\\d+)?>)?\\s*$`, 'i');
  return re.test(before);
}

function parseFetchUidAttr(raw) {
  if (typeof raw !== 'string') return null;
  const matches = raw.match(/\bUID\s+(\d+)\b/gi);
  if (!matches || matches.length !== 1) return null;
  const num = /\bUID\s+(\d+)\b/i.exec(matches[0]);
  if (!num) return null;
  return parseRfcUid(num[1]);
}

function parseFetchUidFlagsDate(raw, uidvalidity) {
  if (typeof raw !== 'string' || !/\bFETCH\b/i.test(raw)) return null;
  const uid = parseFetchUidAttr(raw);
  if (uid == null) return null;
  const parsedUidvalidity = parseRfcUidvalidity(uidvalidity);
  if (parsedUidvalidity == null) return null;
  const flagsMatch = /\bFLAGS\s+\(([^)]*)\)/i.exec(raw);
  const flags = flagsMatch && flagsMatch[1].trim()
    ? flagsMatch[1].trim().split(/\s+/).filter(Boolean)
    : [];
  const dateMatch = /\bINTERNALDATE\s+"([^"]+)"/i.exec(raw);
  if (!dateMatch) return null;
  return {
    uid,
    uidvalidity: parsedUidvalidity,
    flags,
    internalDate: dateMatch[1],
  };
}

function parseRfc822SizeAttr(raw) {
  if (typeof raw !== 'string') return null;
  const matches = raw.match(/\bRFC822\.SIZE\s+(\d+)\b/gi);
  if (!matches || matches.length !== 1) return null;
  const num = /\bRFC822\.SIZE\s+(\d+)\b/i.exec(matches[0]);
  if (!num) return null;
  const value = parseUnsignedDecimal(num[1]);
  if (value == null) return null;
  return value;
}

function parseFetchPreflight(item, uidvalidity) {
  const raw = item && item.text;
  const meta = parseFetchUidFlagsDate(raw, uidvalidity);
  if (!meta) return null;
  const rfc822Size = parseRfc822SizeAttr(raw);
  if (rfc822Size == null) return null;
  const parsedStructure = parseImapBodystructure(raw);
  if (!parsedStructure) return null;
  const selected = selectSafeTextPlainPart(parsedStructure.tree, {
    maxOctets: EMAIL_INBOUND_BODY_TEXT_MAX,
  });
  if (!selected) return null;
  const captures = Array.isArray(item.captures) ? item.captures : [];
  let headerBytes = null;
  let headerCaptures = 0;
  for (let i = 0; i < captures.length; i += 1) {
    const cap = captures[i];
    if (!cap || typeof cap.before !== 'string' || !Buffer.isBuffer(cap.bytes)) continue;
    if (isFullMessageBodyCapture(cap.before) || /BODY(?:\.PEEK)?\[TEXT\]/i.test(cap.before)) {
      return null;
    }
    if (!isHeaderFieldsCapture(cap.before)) continue;
    headerCaptures += 1;
    headerBytes = cap.bytes;
  }
  if (headerCaptures !== 1 || !headerBytes) return null;
  if (headerBytes.length < 1 || headerBytes.length >= IMAP_HEADER_FETCH_MAX) return null;
  let headerEnd = headerBytes.length;
  while (headerEnd >= 2 && headerBytes[headerEnd - 2] === 0x0d && headerBytes[headerEnd - 1] === 0x0a) {
    headerEnd -= 2;
  }
  if (headerEnd < 1) return null;
  const headers = parseRawHeaders(headerBytes.slice(0, headerEnd));
  if (!headers) return null;
  return Object.freeze({
    uid: meta.uid,
    uidvalidity: meta.uidvalidity,
    flags: Object.freeze(meta.flags.slice()),
    internalDate: meta.internalDate,
    rfc822Size,
    headers,
    selected,
  });
}

const SELECTED_SECTION_PROHIBITED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isExplicitUtf8Charset(charset) {
  if (typeof charset !== 'string') return false;
  const declared = charset.trim().toLowerCase();
  return declared === 'utf-8' || declared === 'utf8';
}

function decodeFatalUtf8SelectedLiteral(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    return null;
  }
  if (typeof text !== 'string' || text.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  if (SELECTED_SECTION_PROHIBITED.test(text.replace(/\r\n|\n|\r/g, ''))) return null;
  return text;
}

/**
 * Decode a bounded selected text/plain section.
 *
 * RFC 2045 7BIT is US-ASCII. Bounded Gmail 7BIT UTF-8 selected-section normalization:
 * Gmail sometimes returns raw UTF-8 octets in a part
 * declared 7BIT when BODYSTRUCTURE charset is explicit UTF-8/UTF8.
 * That mismatch is accepted only at this IMAP selected-section boundary,
 * after exact declared-vs-actual octet match, and only when the complete
 * bounded literal is fatal-UTF-8-valid. Absent charset, US-ASCII, Latin-1,
 * unsupported charset, invalid/overlong/surrogate/truncated UTF-8, and
 * NUL/control policy violations stay fail-closed. quoted-printable, base64,
 * and 8bit decoders are unchanged; RFC MIME decodeTransfer remains strict
 * 7BIT ASCII for BODY[] / unrelated paths.
 */
function decodeSelectedSectionLiteral(bodyBytes, encoding, charset) {
  if (!Buffer.isBuffer(bodyBytes) || bodyBytes.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  const cte = typeof encoding === 'string' ? encoding.trim().toLowerCase() : encoding;
  const decoded = decodeTransfer(bodyBytes, cte);
  if (decoded) {
    if (decoded.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
    const name = inferCharset(decoded, charset);
    const text = decodeCharset(decoded, name);
    if (typeof text !== 'string' || text.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
    return text;
  }
  if (cte !== '7bit' || !isExplicitUtf8Charset(charset)) return null;
  return decodeFatalUtf8SelectedLiteral(bodyBytes);
}

function parseFetchSection(item, expected) {
  if (!expected || !isValidImapSection(expected.section)) return null;
  const raw = item && item.text;
  if (typeof raw !== 'string' || !/\bFETCH\b/i.test(raw)) return null;
  const uid = parseFetchUidAttr(raw);
  if (uid == null || uid !== expected.uid) return null;
  const captures = Array.isArray(item.captures) ? item.captures : [];
  let bodyBytes = null;
  let bodyCaptures = 0;
  for (let i = 0; i < captures.length; i += 1) {
    const cap = captures[i];
    if (!cap || typeof cap.before !== 'string' || !Buffer.isBuffer(cap.bytes)) continue;
    if (isFullMessageBodyCapture(cap.before) || /BODY(?:\.PEEK)?\[TEXT\]/i.test(cap.before)) {
      return null;
    }
    if (!isSectionCapture(cap.before, expected.section)) continue;
    bodyCaptures += 1;
    bodyBytes = cap.bytes;
  }
  if (bodyCaptures !== 1 || !Buffer.isBuffer(bodyBytes)) return null;
  if (!Number.isInteger(expected.octets) || expected.octets < 0) return null;
  if (bodyBytes.length !== expected.octets) return null;
  if (bodyBytes.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  const text = decodeSelectedSectionLiteral(bodyBytes, expected.encoding, expected.charset);
  if (typeof text !== 'string' || text.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  return Object.freeze({
    uid,
    uidvalidity: expected.uidvalidity,
    flags: Object.freeze((expected.flags || []).slice()),
    internalDate: expected.internalDate,
    headers: expected.headers,
    bodyText: text,
  });
}

function transportFailureName(err) {
  const name = err && err.failedName;
  if (name === 'sunset-imap-password') return ['sunset-imap-password'];
  if (name === 'sunset-imap-username') return ['sunset-imap-username'];
  if (name === 'sunset-imap-tls-mode') return ['sunset-imap-tls-mode'];
  if (name === 'sunset-imap-port') return ['sunset-imap-port'];
  return ['sunset-imap-host'];
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
    assertSafeImapCredential(credentials.username, 'sunset-imap-username');
    assertSafeImapCredential(credentials.password, 'sunset-imap-password');

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
        const bytes = Buffer.from(buf.slice(dataStart, dataStart + n), 'latin1');
        captures.push({ before, bytes });
        text += before;
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
      if (typeof text !== 'string' || IMAP_PROHIBITED_CONTROLS.test(text)) {
        throw new Error('imap_unsafe_command');
      }
      const tag = nextTag();
      const wire = `${tag} ${text}\r\n`;
      if ((wire.match(/\r\n/g) || []).length !== 1) throw new Error('imap_unsafe_command');
      totalBytes = 0;
      socket.write(wire);
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

    const greetingCaps = parseGreetingCapabilityAtoms(greeting.text);
    if (greetingCaps.malformed) throw new Error('imap_capability');
    if (!capabilityHasExactImap4rev1(greetingCaps.atoms || [])) {
      const caps = await command('CAPABILITY');
      if (caps.status !== 'OK') throw new Error('imap_capability');
      requireExactImap4rev1FromCapability(caps.untagged);
    }

    const login = await command(`LOGIN ${quoteImapString(credentials.username)} ${quoteImapString(credentials.password)}`);
    if (login.status !== 'OK') {
      try { await command('LOGOUT'); } catch (_) { /* best effort */ }
      throw Object.assign(new Error('imap_login'), { failedName: 'sunset-imap-password' });
    }

    const selected = await command('SELECT INBOX');
    if (selected.status !== 'OK') throw new Error('imap_select');
    const uidvalidity = parseUidvalidity(selected.untagged);
    const uidnext = parseUidnext(selected.untagged);

    return Object.freeze({
      command,
      uidvalidity,
      uidnext,
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
      return result(false, transportFailureName(err));
    } finally {
      if (session) session.destroy();
    }
  }

  async function fetchInbox(credentials, cursor) {
    let session;
    try {
      session = await openSession(credentials);
      const uidvalidity = parseRfcUidvalidity(session.uidvalidity);
      const uidnext = parseRfcUidnext(session.uidnext);
      if (uidvalidity == null || uidnext == null) {
        await session.logout();
        return result(false, ['sunset-imap-host']);
      }
      let lastUid = IMAP_LAST_UID_MIN;
      if (cursor && cursor.uidvalidity != null) {
        const cursorUidvalidity = parseRfcUidvalidity(cursor.uidvalidity);
        const cursorLast = parseRfcLastUid(cursor.last_uid);
        if (cursorUidvalidity == null || cursorLast == null) {
          await session.logout();
          return result(false, ['sunset-imap-host']);
        }
        if (cursorUidvalidity === uidvalidity) lastUid = cursorLast;
      }
      if (lastUid >= IMAP_UID_MAX) {
        await session.logout();
        return result(true, null, {
          uidvalidity,
          last_uid: lastUid,
          messages: Object.freeze([]),
        });
      }
      const range = boundedUidSearchRange(lastUid, uidnext);
      if (!range) {
        await session.logout();
        return result(true, null, {
          uidvalidity,
          last_uid: lastUid,
          messages: Object.freeze([]),
        });
      }
      const searchCommand = formatBoundedUidSearchCommand(range.start, range.end);
      if (searchCommand.includes('*')) throw new Error('imap_malformed_response');
      const search = await session.command(searchCommand);
      if (search.status !== 'OK') {
        await session.logout();
        return result(false, ['sunset-imap-host']);
      }
      const uids = normalizeSearchUids(parseSearchUids(search.untagged).filter((uid) => (
        uid > lastUid && uid >= range.start && uid <= range.end
      )));
      if (uids.length === 0) {
        const advanced = parseRfcLastUid(range.end);
        if (advanced == null) throw new Error('imap_malformed_response');
        await session.logout();
        return result(true, null, {
          uidvalidity,
          last_uid: advanced,
          messages: Object.freeze([]),
        });
      }
      const spec = formatUidSequenceSet(uids);
      if (spec.includes(':')) throw new Error('imap_malformed_response');
      const preflighted = await session.command(`UID FETCH ${spec} ${IMAP_PREFLIGHT_ATTRS}`);
      if (preflighted.status !== 'OK') {
        await session.logout();
        return result(false, ['sunset-imap-host']);
      }
      const requested = new Set(uids);
      const seen = new Set();
      const prepared = [];
      let batchBytes = 0;
      for (let i = 0; i < preflighted.fetchItems.length; i += 1) {
        const item = preflighted.fetchItems[i];
        const parsed = parseFetchPreflight({ text: item.text, captures: item.captures }, uidvalidity);
        if (!parsed) throw new Error('imap_malformed_response');
        if (!requested.has(parsed.uid) || seen.has(parsed.uid)) {
          throw new Error('imap_unrequested_uid');
        }
        seen.add(parsed.uid);
        batchBytes += parsed.selected.octets;
        if (batchBytes > IMAP_FETCH_BATCH_MAX_BYTES) throw new Error('imap_oversized_response');
        prepared.push(parsed);
      }
      if (seen.size > IMAP_FETCH_MAX_MESSAGES || prepared.length > IMAP_FETCH_MAX_MESSAGES) {
        throw new Error('imap_unrequested_uid');
      }
      if (seen.size !== requested.size) {
        throw new Error('imap_missing_requested_uid');
      }
      for (let i = 0; i < uids.length; i += 1) {
        if (!seen.has(uids[i])) throw new Error('imap_missing_requested_uid');
      }
      const byUid = new Map(prepared.map((item) => [item.uid, item]));
      const messages = [];
      const sectionSeen = new Set();
      for (let i = 0; i < uids.length; i += 1) {
        const prep = byUid.get(uids[i]);
        if (!prep) throw new Error('imap_missing_requested_uid');
        let parsedBody;
        if (prep.selected.octets === 0) {
          parsedBody = Object.freeze({
            uid: prep.uid,
            uidvalidity: prep.uidvalidity,
            flags: prep.flags,
            internalDate: prep.internalDate,
            headers: prep.headers,
            bodyText: '',
          });
        } else {
          const peek = formatBodyPeekSection(prep.selected.section, prep.selected.octets);
          const bodyFetched = await session.command(`UID FETCH ${prep.uid} (${peek})`);
          if (bodyFetched.status !== 'OK') {
            await session.logout();
            return result(false, ['sunset-imap-host']);
          }
          if (bodyFetched.fetchItems.length !== 1) {
            throw new Error(bodyFetched.fetchItems.length < 1
              ? 'imap_missing_requested_uid'
              : 'imap_unrequested_uid');
          }
          parsedBody = parseFetchSection({
            text: bodyFetched.fetchItems[0].text,
            captures: bodyFetched.fetchItems[0].captures,
          }, Object.freeze({
            uid: prep.uid,
            uidvalidity: prep.uidvalidity,
            flags: prep.flags,
            internalDate: prep.internalDate,
            headers: prep.headers,
            section: prep.selected.section,
            encoding: prep.selected.encoding,
            charset: prep.selected.charset,
            octets: prep.selected.octets,
          }));
          if (!parsedBody) throw new Error('imap_malformed_response');
        }
        if (!requested.has(parsedBody.uid) || sectionSeen.has(parsedBody.uid)) {
          throw new Error('imap_unrequested_uid');
        }
        sectionSeen.add(parsedBody.uid);
        messages.push(parsedBody);
      }
      if (sectionSeen.size !== requested.size) {
        throw new Error('imap_missing_requested_uid');
      }
      for (let i = 0; i < uids.length; i += 1) {
        if (!sectionSeen.has(uids[i])) throw new Error('imap_missing_requested_uid');
      }
      await session.logout();
      const maxUid = messages.reduce((acc, msg) => (msg.uid > acc ? msg.uid : acc), lastUid);
      const lastOut = parseRfcLastUid(maxUid);
      if (lastOut == null) throw new Error('imap_malformed_response');
      return result(true, null, {
        uidvalidity,
        last_uid: lastOut,
        messages: Object.freeze(messages.slice()),
      });
    } catch (err) {
      return result(false, transportFailureName(err));
    } finally {
      if (session) session.destroy();
    }
  }

  return Object.freeze({ verifySession, fetchInbox });
}

module.exports = Object.freeze({
  createSunsetImapImapsTransport,
  assertSameImapTag,
  assertSafeImapCredential,
  quoteImapString,
  parseRfcUid,
  parseRfcUidvalidity,
  parseRfcUidnext,
  parseRfcLastUid,
  parseUidvalidity,
  parseUidnext,
  boundedUidSearchRange,
  formatBoundedUidSearchCommand,
  normalizeSearchUids,
  formatUidSequenceSet,
  parseCapabilityAtomList,
  capabilityHasExactImap4rev1,
  parseUntaggedCapabilityAtoms,
  IMAP_VERIFY_COMMANDS,
  formatBodyPeekSection,
  decodeSelectedSectionLiteral,
  IMAP_PREFLIGHT_ATTRS,
  IMAP_FETCH_MAX_MESSAGES,
  IMAP_FETCH_BATCH_MAX_BYTES,
  IMAP_HEADER_FETCH_MAX,
  IMAP_SEARCH_MAX_WINDOW,
  IMAP_PORT,
  IMAP_TLS_MODE,
  IMAP_UID_MIN,
  IMAP_UID_MAX,
  IMAP_LAST_UID_MIN,
  IMAP_CREDENTIAL_MAX,
});
