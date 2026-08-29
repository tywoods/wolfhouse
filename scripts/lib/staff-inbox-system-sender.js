'use strict';

/**
 * Staff Inbox — system / noreply sender detection (count + list filter).
 *
 * Used by the shared conversation inbox WHERE so rail badges, saved-view
 * counts, and conversation lists do not treat automated mailers (GoDaddy,
 * Google/Outlook noreply, Apollo, mailer-daemon, etc.) as guest threads.
 *
 * WhatsApp / phone-only rows (null email) are never excluded.
 * Does not touch inbound ingest, Skipper, Graph, or email-settings.
 *
 * @module staff-inbox-system-sender
 */

/** Local-part prefixes that mark automated / no-reply mailboxes. */
const SYSTEM_LOCAL_PART_RE = /^(?:no[-_]?reply|do[-_]?not[-_]?reply|donotreply|dont[-_]?reply|mailer[-_]?daemon|postmaster|mailer|bounces?|notifications?|newsletter|auto[-_]?confirm|auto[-_]?notify|ne[-_]?pas[-_]?repondre|nao[-_]?responda|no[-_]?responda?r?|daemon)(?:[+._-].*)?$/i;

/**
 * Domains that are commercial automation platforms — never a guest mailbox
 * for Sunset/Wolfhouse inbox counting. Personal hosts (gmail/outlook/hotmail)
 * are intentionally omitted; those rely on local-part patterns only.
 */
const SYSTEM_SENDER_DOMAINS = Object.freeze([
  'apollo.io',
  'email.apollo.io',
  'godaddy.com',
  'email.godaddy.com',
  'secureserver.net',
  'bounce.google.com',
  'accounts.google.com',
]);

function normalizeEmailAddress(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 320) return null;
  return trimmed;
}

function splitEmail(raw) {
  const email = normalizeEmailAddress(raw);
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return {
    email,
    local: email.slice(0, at),
    domain: email.slice(at + 1),
  };
}

function isSystemSenderDomain(domain) {
  if (!domain) return false;
  const d = String(domain).toLowerCase();
  for (let i = 0; i < SYSTEM_SENDER_DOMAINS.length; i += 1) {
    const sys = SYSTEM_SENDER_DOMAINS[i];
    if (d === sys || d.endsWith('.' + sys)) return true;
  }
  return false;
}

/**
 * @param {string|null|undefined} rawEmail
 * @returns {boolean} true when this address should not count as a guest conversation
 */
function isSystemSenderEmail(rawEmail) {
  const parts = splitEmail(rawEmail);
  if (!parts) return false;
  if (SYSTEM_LOCAL_PART_RE.test(parts.local)) return true;
  if (isSystemSenderDomain(parts.domain)) return true;
  return false;
}

/**
 * SQL predicate: conversation row is a system/noreply sender (for NOT (...)).
 * Uses conv.email — the address staff inbox stores for email-channel threads.
 *
 * @param {string} [convAlias='conv']
 * @returns {string}
 */
function sqlConversationIsSystemSender(convAlias) {
  const conv = convAlias || 'conv';
  const emailExpr = `lower(btrim(${conv}.email))`;
  const localExpr = `split_part(${emailExpr}, '@', 1)`;
  const domainExpr = `split_part(${emailExpr}, '@', 2)`;
  const domainClauses = SYSTEM_SENDER_DOMAINS.map((d) => {
    const lit = d.replace(/'/g, "''");
    return `${domainExpr} = '${lit}' OR ${domainExpr} LIKE '%.' || '${lit}'`;
  });
  return `(
    ${conv}.email IS NOT NULL
    AND btrim(${conv}.email) <> ''
    AND position('@' in ${emailExpr}) > 1
    AND (
      ${localExpr} ~* '^(?:no[-_]?reply|do[-_]?not[-_]?reply|donotreply|dont[-_]?reply|mailer[-_]?daemon|postmaster|mailer|bounces?|notifications?|newsletter|auto[-_]?confirm|auto[-_]?notify|ne[-_]?pas[-_]?repondre|nao[-_]?responda|no[-_]?responda?r?|daemon)(?:[+._-].*)?$'
      OR (${domainClauses.join('\n      OR ')})
    )
  )`;
}

/**
 * AND-fragment appended to the shared inbox WHERE (list + counts).
 * @param {string} [convAlias='conv']
 * @returns {string}
 */
function sqlExcludeSystemSenderConversations(convAlias) {
  return `\n  AND NOT ${sqlConversationIsSystemSender(convAlias)}`;
}

module.exports = {
  SYSTEM_LOCAL_PART_RE,
  SYSTEM_SENDER_DOMAINS,
  normalizeEmailAddress,
  isSystemSenderEmail,
  isSystemSenderDomain,
  sqlConversationIsSystemSender,
  sqlExcludeSystemSenderConversations,
};
