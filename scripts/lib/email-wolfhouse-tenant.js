'use strict';

/**
 * Wolfhouse-owned email tenant contract (WOLFHOUSE-EMAIL-001).
 *
 * Independent of Sunset mailbox, OAuth apps, secret refs, and enable flags.
 * Exact-string gates only — never broad truthy. Default off.
 *
 * @module email-wolfhouse-tenant
 */

const WOLFHOUSE_CLIENT_SLUG = 'wolfhouse-somo';
const WOLFHOUSE_LOCATION_KEY = 'wolfhouse-somo';
const WOLFHOUSE_DEPLOYMENT = 'staff-staging';
const WOLFHOUSE_PORTAL_ORIGIN = 'https://staff-staging.lunafrontdesk.com';
const WOLFHOUSE_MS_REDIRECT_URI = `${WOLFHOUSE_PORTAL_ORIGIN}/staff/email/oauth/microsoft/callback`;
const WOLFHOUSE_GOOGLE_REDIRECT_URI = `${WOLFHOUSE_PORTAL_ORIGIN}/staff/email/google/callback`;

const ENV_UI = 'WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED';
const ENV_OAUTH_START = 'WOLFHOUSE_EMAIL_OAUTH_START_ENABLED';
const ENV_GOOGLE_OAUTH_START = 'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_START_ENABLED';
const ENV_DISCONNECT = 'WOLFHOUSE_EMAIL_OAUTH_DISCONNECT_ENABLED';
const ENV_SMTP_REGISTER = 'WOLFHOUSE_EMAIL_SMTP_IDENTITY_REGISTER_ENABLED';
const ENV_DRAFTS = 'WOLFHOUSE_EMAIL_STAFF_DRAFTS_ENABLED';
const ENV_OUTBOUND = 'WOLFHOUSE_EMAIL_STAFF_OUTBOUND_ENABLED';
const ENV_SEND = 'WOLFHOUSE_EMAIL_OUTBOUND_SEND_ENABLED';
const ENV_LUNA_GENERATE = 'WOLFHOUSE_EMAIL_LUNA_GENERATE_DRAFT_ENABLED';

const WOLFHOUSE_MS_SECRET_REF = 'secret-ref:email/microsoft/wolfhouse-staff-staging-oauth-client';
const WOLFHOUSE_GOOGLE_SECRET_REF = 'secret-ref:email/google/wolfhouse-staff-staging-oauth-client';
const WOLFHOUSE_SMTP_IDENTITY_SECRET_REF = 'secret-ref:email/smtp/wolfhouse-staff-staging';

function ownData(obj, key) {
  try {
    if (!obj || typeof obj !== 'object') return undefined;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    return desc && Object.prototype.hasOwnProperty.call(desc, 'value') && !desc.get && !desc.set
      ? desc.value
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function exactTrue(env, key) {
  try {
    return ownData(env && typeof env === 'object' ? env : {}, key) === 'true';
  } catch (_) {
    return false;
  }
}

function isWolfhouseClientSlug(slug) {
  return slug === WOLFHOUSE_CLIENT_SLUG;
}

function isWolfhouseEmailSettingsUiEnabled(env) {
  return exactTrue(env, ENV_UI);
}

function isWolfhouseStaffStaging(env) {
  return ownData(env && typeof env === 'object' ? env : {}, 'LUNA_DEPLOYMENT') === WOLFHOUSE_DEPLOYMENT;
}

function isWolfhouseEmailOAuthStartEnabled(env) {
  return exactTrue(env, ENV_OAUTH_START) && isWolfhouseStaffStaging(env);
}

function isWolfhouseEmailGoogleOAuthStartEnabled(env) {
  return isWolfhouseEmailSettingsUiEnabled(env)
    && exactTrue(env, ENV_GOOGLE_OAUTH_START)
    && isWolfhouseStaffStaging(env);
}

function isWolfhouseEmailDisconnectEnabled(env) {
  return isWolfhouseEmailSettingsUiEnabled(env)
    && isWolfhouseStaffStaging(env)
    && exactTrue(env, ENV_DISCONNECT);
}

function isWolfhouseEmailSmtpIdentityRegisterEnabled(env) {
  return exactTrue(env, ENV_SMTP_REGISTER) && isWolfhouseStaffStaging(env);
}

function isWolfhouseEmailStaffDraftsEnabled(env) {
  return exactTrue(env, ENV_DRAFTS);
}

function isWolfhouseEmailStaffOutboundEnabled(env) {
  return exactTrue(env, ENV_OUTBOUND);
}

/** Sending stays default-off. Exact 'true' only; this slice never ships that flag on. */
function isWolfhouseEmailOutboundSendEnabled(env) {
  return exactTrue(env, ENV_SEND);
}

function isWolfhouseEmailLunaGenerateDraftEnabled(env) {
  return isWolfhouseStaffStaging(env)
    && exactTrue(env, ENV_LUNA_GENERATE)
    && exactTrue(env, 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED');
}

function isWolfhouseEmailCaller(user) {
  try {
    return !!(user && typeof user === 'object' && user.client_slug === WOLFHOUSE_CLIENT_SLUG);
  } catch (_) {
    return false;
  }
}

const SQL_RESOLVE_WOLFHOUSE_CLIENT = `
SELECT id::text AS client_id
  FROM clients
 WHERE slug = 'wolfhouse-somo'
 LIMIT 1`.replace(/\s+/g, ' ').trim();

const SQL_PROVE_WOLFHOUSE_CLIENT = `
SELECT id::text AS client_id
  FROM clients
 WHERE slug = 'wolfhouse-somo'
   AND id = $1::uuid
 LIMIT 1
 FOR UPDATE`.replace(/\s+/g, ' ').trim();

module.exports = Object.freeze({
  WOLFHOUSE_CLIENT_SLUG,
  WOLFHOUSE_LOCATION_KEY,
  WOLFHOUSE_DEPLOYMENT,
  WOLFHOUSE_PORTAL_ORIGIN,
  WOLFHOUSE_MS_REDIRECT_URI,
  WOLFHOUSE_GOOGLE_REDIRECT_URI,
  ENV_UI,
  ENV_OAUTH_START,
  ENV_GOOGLE_OAUTH_START,
  ENV_DISCONNECT,
  ENV_SMTP_REGISTER,
  ENV_DRAFTS,
  ENV_OUTBOUND,
  ENV_SEND,
  ENV_LUNA_GENERATE,
  WOLFHOUSE_MS_SECRET_REF,
  WOLFHOUSE_GOOGLE_SECRET_REF,
  WOLFHOUSE_SMTP_IDENTITY_SECRET_REF,
  SQL_RESOLVE_WOLFHOUSE_CLIENT,
  SQL_PROVE_WOLFHOUSE_CLIENT,
  isWolfhouseClientSlug,
  isWolfhouseEmailSettingsUiEnabled,
  isWolfhouseStaffStaging,
  isWolfhouseEmailOAuthStartEnabled,
  isWolfhouseEmailGoogleOAuthStartEnabled,
  isWolfhouseEmailDisconnectEnabled,
  isWolfhouseEmailSmtpIdentityRegisterEnabled,
  isWolfhouseEmailStaffDraftsEnabled,
  isWolfhouseEmailStaffOutboundEnabled,
  isWolfhouseEmailOutboundSendEnabled,
  isWolfhouseEmailLunaGenerateDraftEnabled,
  isWolfhouseEmailCaller,
});
