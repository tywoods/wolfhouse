'use strict';

/**
 * MAIL-MVP-006 generic SMTP outbound composition (default-off).
 * Staff Approve & send for imap_smtp. Always writes the outbound journal.
 * Transport send only when SMTP flags + secret refs are exact. Auto stays off.
 */

const crypto = require('node:crypto');
const {
  evaluateSunsetSmtpSecretRefs,
  SUNSET_SMTP_SECRET_NAMES,
} = require('./email-sunset-smtp-secret-ref-contract');
const { createSunsetSmtpSendTransport } = require('./email-sunset-smtp-send-transport');

const SUNSET_DEPLOYMENT = 'sunset-staging';
const ENV_SMTP_SEND = 'LUNA_EMAIL_SMTP_OUTBOUND_SEND_ENABLED';
const ENV_SMTP_COMPOSITION = 'LUNA_EMAIL_SMTP_OUTBOUND_COMPOSITION_ENABLED';
const ENV_SMTP_AUTO = 'LUNA_EMAIL_SMTP_AUTO_SEND_ENABLED';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_KEYS = Object.freeze([
  'operation_id', 'approval_id', 'message_text', 'client_id', 'location_id', 'location_key',
  'endpoint_id', 'conversation_id', 'actor_staff_user_id', 'provider_mailbox_id',
  'provider_source_message_id', 'provider', 'from_address', 'recipient_email',
]);
const REQUEST_KEYS_WITH_SUBJECT = Object.freeze(REQUEST_KEYS.concat(['subject']));

const SQL_INSERT = `INSERT INTO tenant_email_outbound_send_journal (operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, approval_id, actor_staff_user_id, provider, immutable_draft_id, body_digest, phase, outcome, create_invocation_count, update_invocation_count, send_invocation_count) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid,'imap_smtp',NULL,$9,'claimed','claimed',0,0,0) ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id, approval_id, phase, outcome, provider`.replace(/\s+/g, ' ').trim();
const SQL_CLAIM_CREATE = `UPDATE tenant_email_outbound_send_journal SET phase='create_dispatched', outcome='outcome_unknown', create_invocation_count=1 WHERE operation_id=$1::uuid AND phase='claimed' AND outcome='claimed' AND immutable_draft_id IS NULL AND create_invocation_count=0 AND update_invocation_count=0 AND send_invocation_count=0 RETURNING operation_id`.replace(/\s+/g, ' ').trim();
const SQL_DRAFT = `UPDATE tenant_email_outbound_send_journal SET phase='draft_created', outcome='not_committed', immutable_draft_id=$2 WHERE operation_id=$1::uuid AND phase='create_dispatched' AND outcome='outcome_unknown' AND immutable_draft_id IS NULL AND create_invocation_count=1 AND update_invocation_count=0 AND send_invocation_count=0 RETURNING operation_id`.replace(/\s+/g, ' ').trim();
const SQL_CLAIM_UPDATE = `UPDATE tenant_email_outbound_send_journal SET phase='update_dispatched', outcome='outcome_unknown', update_invocation_count=1 WHERE operation_id=$1::uuid AND phase='draft_created' AND outcome='not_committed' AND immutable_draft_id IS NOT NULL AND immutable_draft_id=$2 AND create_invocation_count=1 AND update_invocation_count=0 AND send_invocation_count=0 RETURNING operation_id`.replace(/\s+/g, ' ').trim();
const SQL_UPDATED = `UPDATE tenant_email_outbound_send_journal SET phase='draft_updated', outcome='not_committed' WHERE operation_id=$1::uuid AND phase='update_dispatched' AND outcome='outcome_unknown' AND immutable_draft_id IS NOT NULL AND create_invocation_count=1 AND update_invocation_count=1 AND send_invocation_count=0 RETURNING operation_id`.replace(/\s+/g, ' ').trim();
const SQL_DISPATCH = `UPDATE tenant_email_outbound_send_journal SET phase='send_dispatched', outcome='outcome_unknown', send_invocation_count=1 WHERE operation_id=$1::uuid AND phase='draft_updated' AND outcome='not_committed' AND immutable_draft_id IS NOT NULL AND create_invocation_count=1 AND update_invocation_count=1 AND send_invocation_count=0 RETURNING operation_id`.replace(/\s+/g, ' ').trim();
const SQL_RECONCILE = `UPDATE tenant_email_outbound_send_journal SET phase='reconciled_sent', outcome='committed' WHERE operation_id=$1::uuid AND phase='send_dispatched' AND outcome='outcome_unknown' AND immutable_draft_id IS NOT NULL AND create_invocation_count=1 AND update_invocation_count=1 AND send_invocation_count=1 AND immutable_draft_id=$2 RETURNING operation_id`.replace(/\s+/g, ' ').trim();
const SQL_TERMINAL = `UPDATE tenant_email_outbound_send_journal SET phase='terminal', outcome=$2 WHERE operation_id=$1::uuid AND phase=$3 AND create_invocation_count=$4::integer AND update_invocation_count=$5::integer AND send_invocation_count=$6::integer RETURNING operation_id`.replace(/\s+/g, ' ').trim();

function ownData(o, k) {
  try {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch {
    return undefined;
  }
}

function parseUuid(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return UUID_RE.test(t) && t === raw.trim().toLowerCase() ? t : null;
}

function bodyDigestOf(text) {
  try {
    if (typeof text !== 'string' || text.length < 1) return null;
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

function isEmailSmtpOutboundSendEnabled(env) {
  try {
    return !!env && ownData(env, ENV_SMTP_SEND) === 'true'
      && ownData(env, ENV_SMTP_COMPOSITION) === 'true'
      && ownData(env, 'LUNA_DEPLOYMENT') === SUNSET_DEPLOYMENT;
  } catch {
    return false;
  }
}

function isEmailSmtpAutoSendEnabled(env) {
  try {
    return isEmailSmtpOutboundSendEnabled(env)
      && ownData(env, 'LUNA_AUTO_SEND_ENABLED') === 'true'
      && ownData(env, 'LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED') === 'true'
      && ownData(env, ENV_SMTP_AUTO) === 'true';
  } catch {
    return false;
  }
}

function snapshotRequest(raw) {
  try {
    const keys = Object.keys(raw || {});
    const expected = keys.includes('subject') ? REQUEST_KEYS_WITH_SUBJECT : REQUEST_KEYS;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (keys.length !== expected.length || expected.some((k) => !Object.prototype.hasOwnProperty.call(raw, k))) return null;
    const operationId = parseUuid(ownData(raw, 'operation_id'));
    const approvalId = parseUuid(ownData(raw, 'approval_id'));
    const clientId = parseUuid(ownData(raw, 'client_id'));
    const locationId = parseUuid(ownData(raw, 'location_id'));
    const endpointId = parseUuid(ownData(raw, 'endpoint_id'));
    const conversationId = parseUuid(ownData(raw, 'conversation_id'));
    const actorStaffUserId = parseUuid(ownData(raw, 'actor_staff_user_id'));
    const locationKey = ownData(raw, 'location_key');
    const messageText = ownData(raw, 'message_text');
    const mailbox = ownData(raw, 'provider_mailbox_id');
    const source = ownData(raw, 'provider_source_message_id');
    const provider = ownData(raw, 'provider');
    const fromAddress = ownData(raw, 'from_address');
    const recipientEmail = ownData(raw, 'recipient_email');
    if (!operationId || !approvalId || !clientId || !locationId || !endpointId || !conversationId || !actorStaffUserId) return null;
    if (typeof locationKey !== 'string' || !LOCATION_KEY_RE.test(locationKey) || locationKey.length > 64) return null;
    if (typeof messageText !== 'string' || messageText.length < 1 || messageText.length > 64000) return null;
    if (provider !== 'imap_smtp') return null;
    if (typeof mailbox !== 'string' || mailbox !== fromAddress || !ADDRESS_RE.test(fromAddress)) return null;
    if (typeof recipientEmail !== 'string' || !ADDRESS_RE.test(recipientEmail)) return null;
    if (typeof source !== 'string' || source.length < 1 || source.indexOf('@') !== -1) return null;
    const out = {
      operationId, approvalId, messageText, clientId, locationId, locationKey, endpointId,
      conversationId, actorStaffUserId, mailbox, source, fromAddress, recipientEmail,
    };
    if (keys.includes('subject')) {
      const subject = ownData(raw, 'subject');
      if (subject != null && (typeof subject !== 'string' || /[\r\n]/.test(subject))) return null;
      out.subject = subject;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

async function loadSecrets(env, secretProvider) {
  const refs = evaluateSunsetSmtpSecretRefs(env);
  if (!refs.ok) return { ok: false, missing: refs.missing_secret_names };
  if (!secretProvider || typeof secretProvider.resolveSecret !== 'function') {
    return { ok: false, missing: SUNSET_SMTP_SECRET_NAMES.slice() };
  }
  const values = [];
  for (let i = 0; i < refs.secret_refs.length; i += 1) {
    try {
      const value = await secretProvider.resolveSecret(refs.secret_refs[i]);
      if (typeof value !== 'string' || value.length < 1) {
        return { ok: false, missing: [SUNSET_SMTP_SECRET_NAMES[i]] };
      }
      values.push(value);
    } catch (_) {
      return { ok: false, missing: [SUNSET_SMTP_SECRET_NAMES[i]] };
    }
  }
  const port = Number(values[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, missing: ['sunset-smtp-port'] };
  if (values[2] !== 'starttls') return { ok: false, missing: ['sunset-smtp-tls-mode'] };
  return Object.freeze({
    ok: true,
    credentials: Object.freeze({
      host: values[0], port, tlsMode: values[2], username: values[3], password: values[4],
    }),
  });
}

function createSunsetStagingEmailSmtpOutboundDispatch(deps) {
  const env = deps && deps.env;
  const withTransactionClient = deps && deps.withTransactionClient;
  const secretProvider = deps && deps.secretProvider;
  const smtpTransport = (deps && deps.smtpTransport)
    || createSunsetSmtpSendTransport();
  if (typeof withTransactionClient !== 'function') {
    throw new Error('smtp_outbound_composition_invalid');
  }

  async function dispatchApprovedOutbound(request) {
    const snap = snapshotRequest(request);
    if (!snap) return Object.freeze({ ok: false, code: 'email_send_unavailable' });
    const digest = bodyDigestOf(snap.messageText);
    if (!digest) return Object.freeze({ ok: false, code: 'email_send_unavailable' });
    const draftId = `smtp-local:${snap.operationId}`;
    try {
      const claimed = await withTransactionClient(async (pg) => {
        const ins = await pg.query(SQL_INSERT, [
          snap.operationId, snap.clientId, snap.locationId, snap.locationKey,
          snap.endpointId, snap.conversationId, snap.approvalId, snap.actorStaffUserId, digest,
        ]);
        return ins && Array.isArray(ins.rows) && ins.rows.length === 1;
      });
      if (!claimed) return Object.freeze({ ok: false, code: 'email_send_unavailable' });

      const sendReady = isEmailSmtpOutboundSendEnabled(env);
      const secrets = sendReady ? await loadSecrets(env, secretProvider) : { ok: false, missing: SUNSET_SMTP_SECRET_NAMES.slice() };
      const canSend = sendReady && secrets.ok === true
        && smtpTransport && typeof smtpTransport.sendMail === 'function';
      if (!canSend) {
        await withTransactionClient(async (pg) => {
          await pg.query(SQL_TERMINAL, [snap.operationId, 'not_committed', 'claimed', 0, 0, 0]);
        });
        return Object.freeze({ ok: false, code: sendReady ? 'email_send_unavailable' : 'email_send_disabled' });
      }

      await withTransactionClient(async (pg) => {
        await pg.query(SQL_CLAIM_CREATE, [snap.operationId]);
        await pg.query(SQL_DRAFT, [snap.operationId, draftId]);
        await pg.query(SQL_CLAIM_UPDATE, [snap.operationId, draftId]);
        await pg.query(SQL_UPDATED, [snap.operationId]);
        await pg.query(SQL_DISPATCH, [snap.operationId]);
      });
      const sent = await smtpTransport.sendMail(secrets.credentials, Object.freeze({
        from: snap.fromAddress,
        to: snap.recipientEmail,
        subject: snap.subject || undefined,
        text: snap.messageText,
      }));
      if (!sent || sent.ok !== true) {
        await withTransactionClient(async (pg) => {
          await pg.query(SQL_TERMINAL, [snap.operationId, 'outcome_unknown', 'send_dispatched', 1, 1, 1]);
        });
        return Object.freeze({ ok: false, code: 'email_send_outcome_unknown' });
      }
      await withTransactionClient(async (pg) => {
        await pg.query(SQL_RECONCILE, [snap.operationId, draftId]);
      });
      return Object.freeze({ ok: true, code: 'email_send_committed' });
    } catch (_) {
      return Object.freeze({ ok: false, code: 'email_send_unavailable' });
    }
  }

  return Object.freeze({ dispatchApprovedOutbound });
}

module.exports = Object.freeze({
  SUNSET_DEPLOYMENT,
  ENV_SMTP_SEND,
  ENV_SMTP_COMPOSITION,
  ENV_SMTP_AUTO,
  SQL_INSERT,
  isEmailSmtpOutboundSendEnabled,
  isEmailSmtpAutoSendEnabled,
  createSunsetStagingEmailSmtpOutboundDispatch,
});
