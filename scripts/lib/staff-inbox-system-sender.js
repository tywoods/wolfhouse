'use strict';

/**
 * Staff Inbox — system / noreply sender detection (count + list filter).
 *
 * Used by the shared conversation inbox WHERE so rail badges, saved-view
 * counts, and conversation lists do not treat automated mailers (GoDaddy,
 * Google/Outlook noreply, Apollo, mailer-daemon, etc.) as guest threads.
 *
 * #731 already excluded conv.email when the local-part was a prefix like
 * noreply@. Leftover All-list rows still leaked when:
 *   - the From header was stored wrapped (`Name <mailer-daemon@…>`)
 *   - conv.email was null and the list title came from display_name
 *   - local-part had noreply as a suffix (`microsoft-noreply@…`)
 *
 * WhatsApp / phone-only rows (null email + non-system display_name) stay.
 * Does not touch inbound ingest, Skipper, Graph, or email-settings.
 *
 * @module staff-inbox-system-sender
 */

/** Local-part prefixes that mark automated / no-reply mailboxes. */
const SYSTEM_LOCAL_PART_RE = /^(?:no[-_]?reply|do[-_]?not[-_]?reply|donotreply|dont[-_]?reply|mailer[-_]?daemon|postmaster|mailer|bounces?|notifications?|newsletter|auto[-_]?confirm|auto[-_]?notify|ne[-_]?pas[-_]?repondre|nao[-_]?responda|no[-_]?responda?r?|daemon)(?:[+._-].*)?$/i;

/**
 * noreply / mailer-daemon as a token anywhere in the local-part
 * (`microsoft-noreply`, `foo.no-reply`).
 */
const SYSTEM_NOREPLY_IN_LOCAL_RE = /(?:^|[+._-])(?:no[-_]?reply|do[-_]?not[-_]?reply|donotreply|dont[-_]?reply|mailer[-_]?daemon)(?:[+._-]|$)/i;

/** Display-name / raw From labels with no usable mailbox. */
const SYSTEM_SENDER_LABEL_RE = /(?:^|[^a-z0-9])(?:no[-_]?reply|mailer[-_]?daemon|mail\s+delivery\s+subsystem|postmaster)(?:[^a-z0-9]|$)/i;

const SYSTEM_LOCAL_PART_SQL =
  '^(?:no[-_]?reply|do[-_]?not[-_]?reply|donotreply|dont[-_]?reply|mailer[-_]?daemon|postmaster|mailer|bounces?|notifications?|newsletter|auto[-_]?confirm|auto[-_]?notify|ne[-_]?pas[-_]?repondre|nao[-_]?responda|no[-_]?responda?r?|daemon)(?:[+._-].*)?$';

const SYSTEM_NOREPLY_IN_LOCAL_SQL =
  '(^|[+._-])(?:no[-_]?reply|do[-_]?not[-_]?reply|donotreply|dont[-_]?reply|mailer[-_]?daemon)([+._-]|$)';

const SYSTEM_SENDER_LABEL_SQL =
  '(^|[^[:alnum:]])(?:no[-_]?reply|mailer[-_]?daemon|mail[[:space:]]+delivery[[:space:]]+subsystem|postmaster)([^[:alnum:]]|$)';

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

/**
 * Pull the mailbox out of a raw From / display_name value.
 * Handles `Name <addr@host>` as well as a bare address.
 */
function extractEmailAddress(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const angle = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angle) return normalizeEmailAddress(angle[1]);
  return normalizeEmailAddress(text);
}

function splitEmail(raw) {
  const email = extractEmailAddress(raw);
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

function isSystemSenderLabel(raw) {
  if (raw == null) return false;
  const text = String(raw).trim();
  if (!text) return false;
  return SYSTEM_SENDER_LABEL_RE.test(text);
}

/**
 * @param {string|null|undefined} rawEmail
 * @returns {boolean} true when this address should not count as a guest conversation
 */
function isSystemSenderEmail(rawEmail) {
  if (isSystemSenderLabel(rawEmail)) return true;
  const parts = splitEmail(rawEmail);
  if (!parts) return false;
  if (SYSTEM_LOCAL_PART_RE.test(parts.local)) return true;
  if (SYSTEM_NOREPLY_IN_LOCAL_RE.test(parts.local)) return true;
  if (isSystemSenderDomain(parts.domain)) return true;
  return false;
}

/**
 * List-row shaped check: All-list titles come from display_name when email is
 * empty, so both fields must be classified.
 *
 * @param {{ email?: string|null, display_name?: string|null, guest_name?: string|null }|null|undefined} row
 * @returns {boolean}
 */
function isSystemSenderConversation(row) {
  if (!row) return false;
  return (
    isSystemSenderEmail(row.email)
    || isSystemSenderEmail(row.display_name)
    || isSystemSenderEmail(row.guest_name)
  );
}

function sqlExtractedEmailExpr(colExpr) {
  return `lower(btrim(COALESCE(NULLIF(substring(${colExpr} from '<([^<>[:space:]]+@[^<>[:space:]]+)>'), ''), ${colExpr})))`;
}

function sqlDomainClauses(domainExpr) {
  return SYSTEM_SENDER_DOMAINS.map((d) => {
    const lit = d.replace(/'/g, "''");
    return `${domainExpr} = '${lit}' OR ${domainExpr} LIKE '%.' || '${lit}'`;
  }).join('\n      OR ');
}

/**
 * One column (email or display_name) looks like a system/noreply sender.
 * @param {string} colExpr SQL expression for the text column
 * @returns {string}
 */
function sqlColumnIsSystemSender(colExpr) {
  const extracted = sqlExtractedEmailExpr(colExpr);
  const localExpr = `split_part(${extracted}, '@', 1)`;
  const domainExpr = `split_part(${extracted}, '@', 2)`;
  return `(
    ${colExpr} IS NOT NULL
    AND btrim(${colExpr}) <> ''
    AND (
      lower(btrim(${colExpr})) ~* '${SYSTEM_SENDER_LABEL_SQL}'
      OR (
        position('@' in ${extracted}) > 1
        AND (
          ${localExpr} ~* '${SYSTEM_LOCAL_PART_SQL}'
          OR ${localExpr} ~* '${SYSTEM_NOREPLY_IN_LOCAL_SQL}'
          OR (${sqlDomainClauses(domainExpr)})
        )
      )
    )
  )`;
}

/**
 * SQL predicate: conversation row is a system/noreply sender (for NOT (...)).
 * Checks conv.email and conv.display_name so All-list titles still hide when
 * the mailbox was stored on the display name or inside a wrapped From header.
 *
 * @param {string} [convAlias='conv']
 * @returns {string}
 */
function sqlConversationIsSystemSender(convAlias) {
  const conv = convAlias || 'conv';
  return `(
    ${sqlColumnIsSystemSender(`${conv}.email`)}
    OR ${sqlColumnIsSystemSender(`${conv}.display_name`)}
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
  SYSTEM_NOREPLY_IN_LOCAL_RE,
  SYSTEM_SENDER_LABEL_RE,
  SYSTEM_SENDER_DOMAINS,
  normalizeEmailAddress,
  extractEmailAddress,
  isSystemSenderEmail,
  isSystemSenderDomain,
  isSystemSenderLabel,
  isSystemSenderConversation,
  sqlConversationIsSystemSender,
  sqlExcludeSystemSenderConversations,
};
