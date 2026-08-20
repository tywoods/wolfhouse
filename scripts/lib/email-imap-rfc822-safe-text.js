'use strict';

/**
 * Bounded RFC 822 / MIME extractor for IMAP BODY[] literals.
 * Fail-closed: folded headers, multipart, quoted-printable, base64, UTF-8
 * textual content only. Never logs raw/provider content.
 *
 * @module email-imap-rfc822-safe-text
 */

const {
  EMAIL_INBOUND_BODY_TEXT_MAX,
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
} = require('./email-inbound-envelope-contract');

const MAX_RFC822_BYTES = 65536 + 8192;
const MAX_HEADER_BLOCK = 8192;
const MAX_HEADERS = 64;
const MAX_PARTS = 16;
const MAX_DEPTH = 4;
const MAX_BOUNDARY = 70;
const PROHIBITED_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const DUP_HEADER_KEYS = new Set(['from', 'subject', 'message-id']);

function parseRfc822SafeText(input) {
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > MAX_RFC822_BYTES) {
    return null;
  }
  const entity = extractTextFromEntity(input, 0);
  if (!entity || typeof entity.text !== 'string') return null;
  if (entity.text.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  if (PROHIBITED_TEXT.test(entity.text.replace(/\r\n|\n|\r/g, ''))) return null;
  return Object.freeze({
    headers: Object.freeze(Object.assign(Object.create(null), entity.headers)),
    bodyText: entity.text,
  });
}

function extractTextFromEntity(bytes, depth) {
  if (!Buffer.isBuffer(bytes) || depth > MAX_DEPTH) return null;
  const split = splitHeaderBody(bytes);
  if (!split) return null;
  const headers = parseRawHeaders(split.headerBytes);
  if (!headers) return null;
  const disposition = headers['content-disposition']
    ? String(headers['content-disposition']).trim().toLowerCase()
    : '';
  if (disposition.startsWith('attachment')) {
    return { headers, text: null, skip: true };
  }
  const ct = parseContentType(headers['content-type'] || 'text/plain');
  if (!ct) return null;
  const cte = parseTransferEncoding(headers['content-transfer-encoding']);
  if (!cte) return null;

  if (ct.type === 'multipart') {
    const boundary = ct.params.boundary;
    if (typeof boundary !== 'string' || boundary.length < 1 || boundary.length > MAX_BOUNDARY) {
      return null;
    }
    if (/[\r\n\0]/.test(boundary)) return null;
    const parts = splitMultipart(split.bodyBytes, boundary);
    if (!parts) return null;
    for (let i = 0; i < parts.length; i += 1) {
      const inner = extractTextFromEntity(parts[i], depth + 1);
      if (!inner) return null;
      if (inner.skip) continue;
      if (typeof inner.text === 'string') return { headers, text: inner.text };
    }
    return { headers, text: null };
  }

  if (ct.type === 'text' && ct.subtype === 'plain') {
    const decoded = decodeTransfer(split.bodyBytes, cte);
    if (!decoded) return null;
    if (decoded.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
    const charset = inferCharset(decoded, ct.params.charset);
    const text = decodeCharset(decoded, charset);
    if (typeof text !== 'string') return null;
    return { headers, text };
  }

  return { headers, text: null };
}

function splitHeaderBody(bytes) {
  const sep = Buffer.from('\r\n\r\n');
  const idx = bytes.indexOf(sep);
  if (idx < 0 || idx > MAX_HEADER_BLOCK) return null;
  return {
    headerBytes: bytes.slice(0, idx),
    bodyBytes: bytes.slice(idx + 4),
  };
}

function parseRawHeaders(headerBytes) {
  if (!Buffer.isBuffer(headerBytes) || headerBytes.length > MAX_HEADER_BLOCK) return null;
  for (let i = 0; i < headerBytes.length; i += 1) {
    if (headerBytes[i] > 127 || headerBytes[i] === 0) return null;
  }
  const raw = headerBytes.toString('ascii');
  const physical = raw.split('\r\n');
  const logical = [];
  for (let i = 0; i < physical.length; i += 1) {
    const line = physical[i];
    if (line.includes('\n') || line.includes('\r') || line.includes('\0')) return null;
    if (/^[ \t]/.test(line)) {
      if (logical.length === 0) return null;
      logical[logical.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (line === '') return null;
    logical.push(line);
  }
  if (logical.length < 1 || logical.length > MAX_HEADERS) return null;
  const headers = Object.create(null);
  for (let i = 0; i < logical.length; i += 1) {
    const line = logical[i];
    const colon = line.indexOf(':');
    if (colon < 1) return null;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!HEADER_NAME_RE.test(name)) return null;
    if (PROHIBITED_TEXT.test(value) || /\r|\n/.test(value)) return null;
    if (value.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) return null;
    const key = name.toLowerCase();
    if (DUP_HEADER_KEYS.has(key) && Object.prototype.hasOwnProperty.call(headers, key)) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(headers, key)) headers[key] = value;
  }
  return headers;
}

function unquoteParam(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    let inner = value.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] === '\\') {
        if (i + 1 >= inner.length) return null;
        out += inner[i + 1];
        i += 1;
        continue;
      }
      if (inner[i] === '"') return null;
      out += inner[i];
    }
    return out;
  }
  return value;
}

function parseContentType(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { type: 'text', subtype: 'plain', params: Object.create(null) };
  }
  const parts = splitParams(value);
  if (!parts) return null;
  const mime = parts[0].toLowerCase();
  const slash = mime.indexOf('/');
  if (slash < 1 || slash === mime.length - 1) return null;
  const type = mime.slice(0, slash).trim();
  const subtype = mime.slice(slash + 1).trim();
  if (!TOKEN_RE.test(type) || !TOKEN_RE.test(subtype)) return null;
  const params = Object.create(null);
  for (let i = 1; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    const eq = parts[i].indexOf('=');
    if (eq < 1) return null;
    const pname = parts[i].slice(0, eq).trim().toLowerCase();
    const pval = unquoteParam(parts[i].slice(eq + 1).trim());
    if (!pname || pval == null) return null;
    params[pname] = pval;
  }
  return { type, subtype, params };
}

function splitParams(value) {
  const parts = [];
  let current = '';
  let inQuote = false;
  let escape = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inQuote) {
      escape = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (ch === ';' && !inQuote) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (inQuote || escape) return null;
  parts.push(current.trim());
  if (!parts[0]) return null;
  return parts;
}

function parseTransferEncoding(value) {
  if (value == null || value === '') return '7bit';
  const v = String(value).trim().toLowerCase();
  if (v === '7bit' || v === '8bit' || v === 'quoted-printable' || v === 'base64') return v;
  return null;
}

function decodeTransfer(buf, cte) {
  if (cte === 'quoted-printable') return decodeQuotedPrintable(buf);
  if (cte === 'base64') return decodeBase64(buf);
  if (cte === '7bit') {
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] > 127) return null;
    }
    return buf;
  }
  if (cte === '8bit') return buf;
  return null;
}

function inferCharset(buf, declared) {
  if (declared) return declared;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] > 127) return 'utf-8';
  }
  return 'us-ascii';
}

function decodeQuotedPrintable(buf) {
  const s = buf.toString('latin1');
  if (/[^\t\r\n\x20-\x7e]/.test(s)) return null;
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '=') {
      out.push(s.charCodeAt(i));
      continue;
    }
    if (s[i + 1] === '\r' && s[i + 2] === '\n') {
      i += 2;
      continue;
    }
    const hex = s.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
    out.push(Number.parseInt(hex, 16));
    i += 2;
  }
  if (out.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  return Buffer.from(out);
}

function decodeBase64(buf) {
  const s = buf.toString('latin1').replace(/[\r\n\t ]/g, '');
  if (s.length === 0) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  const padIndex = s.indexOf('=');
  if (padIndex >= 0 && padIndex !== s.length - 1 && padIndex !== s.length - 2) return null;
  if (s.endsWith('====')) return null;
  let decoded;
  try {
    decoded = Buffer.from(s, 'base64');
  } catch (_) {
    return null;
  }
  if (decoded.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  const roundtrip = decoded.toString('base64').replace(/=+$/, '');
  if (roundtrip !== s.replace(/=+$/, '')) return null;
  return decoded;
}

function decodeCharset(buf, charset) {
  if (!Buffer.isBuffer(buf) || buf.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
  const name = String(charset || 'us-ascii').trim().toLowerCase();
  if (name === 'utf-8' || name === 'utf8') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      if (text.length > EMAIL_INBOUND_BODY_TEXT_MAX) return null;
      return text;
    } catch (_) {
      return null;
    }
  }
  if (name === 'us-ascii' || name === 'ascii') {
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] > 127) return null;
    }
    return buf.toString('ascii');
  }
  if (name === 'iso-8859-1' || name === 'latin1') {
    return buf.toString('latin1');
  }
  return null;
}

function splitMultipart(bodyBytes, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const crlfDelim = Buffer.from(`\r\n--${boundary}`);
  const close = Buffer.from('--');
  const crlf = Buffer.from('\r\n');
  let first = -1;
  if (bodyBytes.length >= delim.length && bodyBytes.compare(delim, 0, delim.length, 0, delim.length) === 0) {
    first = 0;
  } else {
    const idx = bodyBytes.indexOf(crlfDelim);
    if (idx < 0) return null;
    first = idx + 2;
  }
  let pos = first + delim.length;
  if (pos + 2 <= bodyBytes.length && bodyBytes.compare(close, 0, 2, pos, pos + 2) === 0) {
    return [];
  }
  if (pos + 2 > bodyBytes.length || bodyBytes.compare(crlf, 0, 2, pos, pos + 2) !== 0) return null;
  pos += 2;
  const parts = [];
  while (parts.length <= MAX_PARTS) {
    const next = bodyBytes.indexOf(crlfDelim, pos);
    if (next < 0) return null;
    parts.push(bodyBytes.slice(pos, next));
    pos = next + crlfDelim.length;
    if (pos + 2 <= bodyBytes.length && bodyBytes.compare(close, 0, 2, pos, pos + 2) === 0) {
      return parts.length > MAX_PARTS ? null : parts;
    }
    if (pos + 2 > bodyBytes.length || bodyBytes.compare(crlf, 0, 2, pos, pos + 2) !== 0) return null;
    pos += 2;
  }
  return null;
}

module.exports = Object.freeze({
  parseRfc822SafeText,
  MAX_RFC822_BYTES,
});
