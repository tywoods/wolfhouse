'use strict';

/**
 * Strict bounded IMAP BODYSTRUCTURE parser and text/plain part selector.
 * Fail-closed. Never logs provider content. Never selects attachments or
 * non-text/plain bodies. No literals inside BODYSTRUCTURE.
 *
 * @module email-imap-bodystructure
 */

const { EMAIL_INBOUND_BODY_TEXT_MAX } = require('./email-inbound-envelope-contract');
const { parseTransferEncoding } = require('./email-imap-rfc822-safe-text');

const IMAP_BODYSTRUCTURE_MAX_INPUT = 8192;
const IMAP_BODYSTRUCTURE_MAX_DEPTH = 8;
const IMAP_BODYSTRUCTURE_MAX_PARTS = 16;
const IMAP_BODYSTRUCTURE_MAX_LISTS = 32;
const IMAP_BODYSTRUCTURE_MAX_LIST_ITEMS = 32;
const IMAP_BODYSTRUCTURE_MAX_STRING = 256;
const IMAP_BODYSTRUCTURE_MAX_TOKENS = 256;
const IMAP_SECTION_RE = /^[1-9][0-9]{0,8}(\.[1-9][0-9]{0,8}){0,7}$/;
const ALLOWED_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii', 'iso-8859-1', 'latin1']);
const UNSAFE_TYPES = new Set(['application', 'image', 'audio', 'video', 'binary', 'message', 'model']);

function skipSp(s, i) {
  while (i < s.length && s[i] === ' ') i += 1;
  return i;
}

function parseQuoted(s, i) {
  if (s[i] !== '"') return null;
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') {
      if (j + 1 >= s.length) return null;
      const next = s[j + 1];
      if (next === '\r' || next === '\n' || next === '\0') return null;
      out += next;
      j += 2;
      continue;
    }
    if (ch === '"') {
      if (out.length > IMAP_BODYSTRUCTURE_MAX_STRING) return null;
      return { value: out, next: j + 1 };
    }
    if (ch === '\r' || ch === '\n' || ch === '\0') return null;
    out += ch;
    if (out.length > IMAP_BODYSTRUCTURE_MAX_STRING) return null;
    j += 1;
  }
  return null;
}

function parseImapSexpr(s, i, depth, counters) {
  if (typeof s !== 'string' || i < 0 || i > s.length) return null;
  if (depth > IMAP_BODYSTRUCTURE_MAX_DEPTH) return null;
  i = skipSp(s, i);
  if (i >= s.length) return null;
  if (s[i] === '{') return null;
  if (s[i] === '"') {
    counters.tokens += 1;
    if (counters.tokens > IMAP_BODYSTRUCTURE_MAX_TOKENS) return null;
    return parseQuoted(s, i);
  }
  if (s[i] === '(') {
    counters.lists += 1;
    if (counters.lists > IMAP_BODYSTRUCTURE_MAX_LISTS) return null;
    let j = i + 1;
    const items = [];
    j = skipSp(s, j);
    while (j < s.length && s[j] !== ')') {
      const part = parseImapSexpr(s, j, depth + 1, counters);
      if (!part) return null;
      items.push(part.value);
      if (items.length > IMAP_BODYSTRUCTURE_MAX_LIST_ITEMS) return null;
      j = skipSp(s, part.next);
    }
    if (j >= s.length || s[j] !== ')') return null;
    return { value: items, next: j + 1 };
  }
  const rest = s.slice(i);
  const atom = /^[^\x00-\x20\x7f(){%*"\\[\]]+/.exec(rest);
  if (!atom) return null;
  counters.tokens += 1;
  if (counters.tokens > IMAP_BODYSTRUCTURE_MAX_TOKENS) return null;
  if (atom[0].length > IMAP_BODYSTRUCTURE_MAX_STRING) return null;
  if (atom[0] === '{' || atom[0].includes('{')) return null;
  if (/^(0|[1-9][0-9]{0,14})$/.test(atom[0])) {
    const n = Number(atom[0]);
    if (!Number.isInteger(n) || !Number.isSafeInteger(n) || n < 0) return null;
    return { value: n, next: i + atom[0].length };
  }
  if (/^NIL$/i.test(atom[0])) {
    return { value: null, next: i + atom[0].length };
  }
  return { value: atom[0], next: i + atom[0].length };
}

function findBodystructureStart(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > IMAP_BODYSTRUCTURE_MAX_INPUT) {
    return -1;
  }
  let inQuote = false;
  let escape = false;
  let hits = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if ((ch === 'B' || ch === 'b') && raw.slice(i, i + 13).toUpperCase() === 'BODYSTRUCTURE') {
      const before = i === 0 ? ' ' : raw[i - 1];
      const after = raw[i + 13];
      if (before !== ' ' && before !== '(') continue;
      if (after !== ' ' && after !== '(' && after !== undefined) continue;
      hits += 1;
      if (hits > 1) return -2;
      start = i + 13;
    }
  }
  return start;
}

function asAtom(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.toLowerCase();
}

function parseParams(value) {
  if (value == null) return Object.create(null);
  if (!Array.isArray(value) || value.length < 2 || value.length % 2 !== 0) return null;
  const params = Object.create(null);
  for (let i = 0; i < value.length; i += 2) {
    const name = asAtom(value[i]);
    const val = value[i + 1];
    if (!name || typeof val !== 'string') return null;
    if (name.length > IMAP_BODYSTRUCTURE_MAX_STRING || val.length > IMAP_BODYSTRUCTURE_MAX_STRING) {
      return null;
    }
    params[name] = val;
  }
  return params;
}

function parseDisposition(value) {
  if (value == null) return '';
  if (!Array.isArray(value) || value.length < 1) return null;
  const kind = asAtom(value[0]);
  if (!kind) return null;
  return kind;
}

function scanDisposition(fields, start) {
  for (let i = start; i < fields.length; i += 1) {
    const item = fields[i];
    if (!Array.isArray(item) || item.length < 1) continue;
    const kind = asAtom(item[0]);
    if (kind === 'attachment' || kind === 'inline') return kind;
  }
  return '';
}

function parseBodyNode(list, depth, counters) {
  if (!Array.isArray(list) || list.length < 1) return null;
  if (depth > 4) return null;
  counters.parts += 1;
  if (counters.parts > IMAP_BODYSTRUCTURE_MAX_PARTS) return null;

  if (Array.isArray(list[0])) {
    const children = [];
    let i = 0;
    while (i < list.length && Array.isArray(list[i])) {
      const child = parseBodyNode(list[i], depth + 1, counters);
      if (!child) return null;
      children.push(child);
      i += 1;
    }
    if (children.length < 1 || i >= list.length) return null;
    const subtype = asAtom(list[i]);
    if (!subtype) return null;
    const params = i + 1 < list.length ? parseParams(list[i + 1] == null ? null : list[i + 1]) : Object.create(null);
    if (params == null && list[i + 1] != null) return null;
    const disposition = scanDisposition(list, i + 2);
    if (disposition == null) return null;
    return {
      kind: 'multipart',
      subtype,
      parts: children,
      params: params || Object.create(null),
      disposition,
    };
  }

  if (list.length < 7) return null;
  const type = asAtom(list[0]);
  const subtype = asAtom(list[1]);
  if (!type || !subtype) return null;
  const params = parseParams(list[2]);
  if (!params) return null;
  const encodingRaw = list[5];
  if (typeof encodingRaw !== 'string' || !encodingRaw) return null;
  const encoding = parseTransferEncoding(encodingRaw);
  if (!encoding) return null;
  const octets = list[6];
  if (!Number.isInteger(octets) || octets < 0 || !Number.isSafeInteger(octets)) return null;
  // RFC 3501 body-type-text: body-fld-lines is mandatory immediately after
  // body-fld-octets and must be a canonical non-negative bounded decimal.
  let extStart = 7;
  if (type === 'text') {
    if (list.length < 8) return null;
    const lines = list[7];
    if (!Number.isInteger(lines) || lines < 0 || !Number.isSafeInteger(lines)) return null;
    extStart = 8;
  }
  const disposition = scanDisposition(list, extStart);
  if (disposition == null) return null;
  const charsetRaw = params.charset;
  const charset = typeof charsetRaw === 'string' && charsetRaw ? charsetRaw.toLowerCase() : null;
  return {
    kind: 'single',
    type,
    subtype,
    params,
    encoding,
    octets,
    charset,
    disposition,
  };
}

function assignSections(node, section) {
  if (!node) return null;
  if (node.kind === 'multipart') {
    for (let i = 0; i < node.parts.length; i += 1) {
      const childSection = section ? `${section}.${i + 1}` : `${i + 1}`;
      if (!IMAP_SECTION_RE.test(childSection)) return null;
      if (!assignSections(node.parts[i], childSection)) return null;
    }
    return node;
  }
  const resolved = section || '1';
  if (!IMAP_SECTION_RE.test(resolved)) return null;
  node.section = resolved;
  return node;
}

function isSafeTextPlainLeaf(node, maxOctets) {
  if (!node || node.kind !== 'single') return false;
  if (node.type !== 'text' || node.subtype !== 'plain') return false;
  if (UNSAFE_TYPES.has(node.type)) return false;
  if (node.disposition === 'attachment') return false;
  if (!node.encoding) return false;
  if (!Number.isInteger(node.octets) || node.octets < 0 || node.octets > maxOctets) return false;
  if (node.charset && !ALLOWED_CHARSETS.has(node.charset)) return false;
  if (typeof node.section !== 'string' || !IMAP_SECTION_RE.test(node.section)) return false;
  return true;
}

function findSafeTextPlain(node, maxOctets) {
  if (!node) return null;
  if (node.kind === 'multipart') {
    for (let i = 0; i < node.parts.length; i += 1) {
      const found = findSafeTextPlain(node.parts[i], maxOctets);
      if (found) return found;
    }
    return null;
  }
  return isSafeTextPlainLeaf(node, maxOctets) ? node : null;
}

function parseImapBodystructure(rawFetchText) {
  const start = findBodystructureStart(rawFetchText);
  if (start < 0) return null;
  const counters = { tokens: 0, lists: 0, parts: 0 };
  const parsed = parseImapSexpr(rawFetchText, skipSp(rawFetchText, start), 0, counters);
  if (!parsed || !Array.isArray(parsed.value)) return null;
  const tree = parseBodyNode(parsed.value, 0, counters);
  if (!tree) return null;
  if (!assignSections(tree, tree.kind === 'multipart' ? '' : '1')) return null;
  return Object.freeze({
    tree,
    parts: counters.parts,
    next: parsed.next,
  });
}

function selectSafeTextPlainPart(tree, opts) {
  const maxOctets = opts && Number.isInteger(opts.maxOctets)
    ? opts.maxOctets
    : EMAIL_INBOUND_BODY_TEXT_MAX;
  if (!tree || typeof tree !== 'object') return null;
  const found = findSafeTextPlain(tree, maxOctets);
  if (!found) return null;
  return Object.freeze({
    section: found.section,
    encoding: found.encoding,
    charset: found.charset,
    octets: found.octets,
  });
}

function selectBoundedTextPlainFromFetchText(rawFetchText, opts) {
  const parsed = parseImapBodystructure(rawFetchText);
  if (!parsed) return null;
  return selectSafeTextPlainPart(parsed.tree, opts);
}

function isValidImapSection(section) {
  return typeof section === 'string' && IMAP_SECTION_RE.test(section);
}

function formatBodyPeekSection(section, count) {
  if (!isValidImapSection(section)) throw new Error('imap_malformed_response');
  if (!Number.isInteger(count) || count < 0 || count > EMAIL_INBOUND_BODY_TEXT_MAX) {
    throw new Error('imap_malformed_response');
  }
  return `BODY.PEEK[${section}]<0.${count}>`;
}

module.exports = Object.freeze({
  parseImapBodystructure,
  selectSafeTextPlainPart,
  selectBoundedTextPlainFromFetchText,
  isValidImapSection,
  formatBodyPeekSection,
  IMAP_BODYSTRUCTURE_MAX_INPUT,
  IMAP_BODYSTRUCTURE_MAX_DEPTH,
  IMAP_BODYSTRUCTURE_MAX_PARTS,
  IMAP_SECTION_RE,
});
