'use strict';

/**
 * Known IMAP/SMTP provider defaults for Staff Email Connect autofill.
 * Known domains only — unknown addresses return null (leave form alone).
 * Staging helper; does not activate OAuth, live send, or mailbox connect.
 *
 * @module email-imap-provider-defaults
 */

const EMAIL_IMAP_PROVIDER_DEFAULTS = Object.freeze([
  Object.freeze({
    id: 'gmail',
    label: 'Gmail',
    domains: Object.freeze(['gmail.com', 'googlemail.com']),
    smtp: Object.freeze({ server: 'smtp.gmail.com', port: 587, tls: 'starttls' }),
    imap: Object.freeze({ server: 'imap.gmail.com', port: 993, tls: 'tls' }),
  }),
  Object.freeze({
    id: 'microsoft',
    label: 'Outlook / Microsoft 365',
    domains: Object.freeze(['outlook.com', 'hotmail.com', 'live.com', 'msn.com']),
    smtp: Object.freeze({ server: 'smtp.office365.com', port: 587, tls: 'starttls' }),
    imap: Object.freeze({ server: 'outlook.office365.com', port: 993, tls: 'tls' }),
  }),
  Object.freeze({
    id: 'yahoo',
    label: 'Yahoo Mail',
    domains: Object.freeze(['yahoo.com', 'ymail.com', 'yahoo.es', 'yahoo.co.uk']),
    smtp: Object.freeze({ server: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' }),
    imap: Object.freeze({ server: 'imap.mail.yahoo.com', port: 993, tls: 'tls' }),
  }),
  Object.freeze({
    id: 'icloud',
    label: 'iCloud',
    domains: Object.freeze(['icloud.com', 'me.com', 'mac.com']),
    smtp: Object.freeze({ server: 'smtp.mail.me.com', port: 587, tls: 'starttls' }),
    imap: Object.freeze({ server: 'imap.mail.me.com', port: 993, tls: 'tls' }),
  }),
  Object.freeze({
    id: 'aol',
    label: 'AOL',
    domains: Object.freeze(['aol.com']),
    smtp: Object.freeze({ server: 'smtp.aol.com', port: 587, tls: 'starttls' }),
    imap: Object.freeze({ server: 'imap.aol.com', port: 993, tls: 'tls' }),
  }),
  Object.freeze({
    id: 'zoho',
    label: 'Zoho Mail',
    domains: Object.freeze(['zoho.com', 'zohomail.com']),
    smtp: Object.freeze({ server: 'smtp.zoho.com', port: 587, tls: 'starttls' }),
    imap: Object.freeze({ server: 'imap.zoho.com', port: 993, tls: 'tls' }),
  }),
]);

const DOMAIN_INDEX = new Map();
for (const row of EMAIL_IMAP_PROVIDER_DEFAULTS) {
  for (const domain of row.domains) {
    DOMAIN_INDEX.set(String(domain).toLowerCase(), row);
  }
}

const AUTOFILL_FIELD_KEYS = Object.freeze([
  'smtp-server',
  'smtp-port',
  'smtp-tls',
  'imap-server',
  'imap-port',
  'imap-tls',
]);

function extractEmailDomain(address) {
  const s = String(address || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return '';
  const domain = s.slice(at + 1).replace(/\.$/, '');
  if (!domain || domain.indexOf('.') < 0) return '';
  return domain;
}

function lookupEmailImapProviderDefaults(addressOrDomain) {
  const raw = String(addressOrDomain || '').trim().toLowerCase();
  if (!raw) return null;
  const domain = raw.indexOf('@') >= 0 ? extractEmailDomain(raw) : raw.replace(/\.$/, '');
  if (!domain) return null;
  const row = DOMAIN_INDEX.get(domain);
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    domain,
    smtp: { server: row.smtp.server, port: row.smtp.port, tls: row.smtp.tls },
    imap: { server: row.imap.server, port: row.imap.port, tls: row.imap.tls },
  };
}

function defaultsToFieldMap(defaults) {
  if (!defaults) return null;
  return {
    'smtp-server': defaults.smtp.server,
    'smtp-port': String(defaults.smtp.port),
    'smtp-tls': defaults.smtp.tls,
    'imap-server': defaults.imap.server,
    'imap-port': String(defaults.imap.port),
    'imap-tls': defaults.imap.tls,
  };
}

/**
 * Build a patch of Advanced fields to set for a known provider.
 * Skips keys marked user-edited. Unknown domains → null (no change).
 *
 * @param {string} address mailbox address
 * @param {Record<string, boolean>|null|undefined} userEditedFlags
 * @returns {Record<string, string>|null}
 */
function suggestEmailImapAutofillPatch(address, userEditedFlags) {
  const defaults = lookupEmailImapProviderDefaults(address);
  if (!defaults) return null;
  const fields = defaultsToFieldMap(defaults);
  const edited = userEditedFlags && typeof userEditedFlags === 'object' ? userEditedFlags : {};
  const patch = {};
  for (const key of AUTOFILL_FIELD_KEYS) {
    if (edited[key] === true) continue;
    patch[key] = fields[key];
  }
  return patch;
}

/**
 * Connect-time host guess: known providers first; otherwise invent smtp./imap. + domain
 * when the address has a plausible domain (legacy empty-field connect behavior).
 */
function guessEmailImapHostFromAddress(kind, address) {
  const defaults = lookupEmailImapProviderDefaults(address);
  if (defaults) {
    return kind === 'smtp' ? defaults.smtp.server : defaults.imap.server;
  }
  const domain = extractEmailDomain(address);
  if (!domain) return '';
  return (kind === 'smtp' ? 'smtp.' : 'imap.') + domain;
}

function listEmailImapProviderDefaultRows() {
  return EMAIL_IMAP_PROVIDER_DEFAULTS.map((row) => ({
    id: row.id,
    label: row.label,
    domains: row.domains.slice(),
    smtp: { server: row.smtp.server, port: row.smtp.port, tls: row.smtp.tls },
    imap: { server: row.imap.server, port: row.imap.port, tls: row.imap.tls },
  }));
}

const api = Object.freeze({
  EMAIL_IMAP_PROVIDER_DEFAULTS,
  AUTOFILL_FIELD_KEYS,
  extractEmailDomain,
  lookupEmailImapProviderDefaults,
  defaultsToFieldMap,
  suggestEmailImapAutofillPatch,
  guessEmailImapHostFromAddress,
  listEmailImapProviderDefaultRows,
});

if (typeof module === 'object' && module.exports) {
  module.exports = api;
}

if (typeof globalThis !== 'undefined') {
  globalThis.EmailImapProviderDefaults = api;
}
