'use strict';

/**
 * WOLFHOUSE-EMAIL-001 isolation + dual-gate verifier.
 *
 * Proves Wolfhouse Admin Email uses Wolfhouse-owned flags, secret refs, SQL
 * slugs, and Luna copy. Sunset mailbox / OAuth apps / sunset-smtp-* names are
 * never reused. Sending stays default-off.
 *
 * Offline only — no network, mailbox, or deploy.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const tenant = require('./lib/email-wolfhouse-tenant');
const wolfSmtp = require('./lib/email-wolfhouse-smtp-secret-ref-contract');
const wolfPrepare = require('./lib/email-wolfhouse-endpoint-prepare');
const remove = require('./lib/email-registered-endpoint-remove');
const author = require('./lib/email-luna-draft-author');
const inbox = require('./lib/staff-email-inbox-routes');
const lunaRoute = require('./lib/staff-email-luna-draft-route');
const inboundMatch = require('./lib/email-inbound-match-ingest');
const sunsetSmtp = require('./lib/email-sunset-smtp-secret-ref-contract');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    return false;
  }
  console.log(`PASS  ${name}`);
  return true;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const WH = 'wolfhouse-somo';
const SUNSET = 'sunset';

console.log('\n── A. Tenant contract ──');
{
  check('A1 trusted slug is wolfhouse-somo', tenant.WOLFHOUSE_CLIENT_SLUG === WH);
  check('A2 location key is wolfhouse-somo', tenant.WOLFHOUSE_LOCATION_KEY === WH);
  check('A3 deployment is staff-staging', tenant.WOLFHOUSE_DEPLOYMENT === 'staff-staging');
  check('A4 portal origin is staff-staging, not sunset-staging',
    tenant.WOLFHOUSE_PORTAL_ORIGIN === 'https://staff-staging.lunafrontdesk.com'
    && !tenant.WOLFHOUSE_PORTAL_ORIGIN.includes('sunset-staging'));
  check('A5 MS redirect is staff-staging',
    tenant.WOLFHOUSE_MS_REDIRECT_URI.includes('staff-staging.lunafrontdesk.com')
    && !tenant.WOLFHOUSE_MS_REDIRECT_URI.includes('sunset-staging'));
  check('A6 Google redirect is staff-staging',
    tenant.WOLFHOUSE_GOOGLE_REDIRECT_URI.includes('staff-staging.lunafrontdesk.com')
    && !tenant.WOLFHOUSE_GOOGLE_REDIRECT_URI.includes('sunset-staging'));
  check('A7 MS secret ref is Wolfhouse-owned',
    tenant.WOLFHOUSE_MS_SECRET_REF === 'secret-ref:email/microsoft/wolfhouse-staff-staging-oauth-client'
    && !tenant.WOLFHOUSE_MS_SECRET_REF.includes('sunset'));
  check('A8 Google secret ref is Wolfhouse-owned',
    tenant.WOLFHOUSE_GOOGLE_SECRET_REF === 'secret-ref:email/google/wolfhouse-staff-staging-oauth-client'
    && !tenant.WOLFHOUSE_GOOGLE_SECRET_REF.includes('sunset'));
  check('A9 SMTP identity secret ref is Wolfhouse-owned',
    tenant.WOLFHOUSE_SMTP_IDENTITY_SECRET_REF.includes('wolfhouse')
    && !tenant.WOLFHOUSE_SMTP_IDENTITY_SECRET_REF.includes('sunset'));
  check('A10 prove SQL pins wolfhouse-somo only',
    tenant.SQL_PROVE_WOLFHOUSE_CLIENT.includes("slug = 'wolfhouse-somo'")
    && !tenant.SQL_PROVE_WOLFHOUSE_CLIENT.includes("slug = 'sunset'"));
}

console.log('\n── B. Flags default off + never Sunset flags ──');
{
  const empty = {};
  check('B1 UI off by default', tenant.isWolfhouseEmailSettingsUiEnabled(empty) === false);
  check('B2 OAuth start off by default', tenant.isWolfhouseEmailOAuthStartEnabled(empty) === false);
  check('B3 Google start off by default', tenant.isWolfhouseEmailGoogleOAuthStartEnabled(empty) === false);
  check('B4 disconnect off by default', tenant.isWolfhouseEmailDisconnectEnabled(empty) === false);
  check('B5 drafts off by default', tenant.isWolfhouseEmailStaffDraftsEnabled(empty) === false);
  check('B6 outbound off by default', tenant.isWolfhouseEmailStaffOutboundEnabled(empty) === false);
  check('B7 send off by default', tenant.isWolfhouseEmailOutboundSendEnabled(empty) === false);
  check('B8 Luna generate off by default', tenant.isWolfhouseEmailLunaGenerateDraftEnabled(empty) === false);
  const sunsetFlags = {
    SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
    LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED: 'true',
    EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true',
    EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
    EMAIL_OUTBOUND_SEND_ENABLED: 'true',
    EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    LUNA_DEPLOYMENT: 'sunset-staging',
  };
  check('B9 Sunset flags do not enable Wolfhouse UI',
    tenant.isWolfhouseEmailSettingsUiEnabled(sunsetFlags) === false);
  check('B10 Sunset flags do not enable Wolfhouse send',
    tenant.isWolfhouseEmailOutboundSendEnabled(sunsetFlags) === false);
  check('B11 Sunset-staging is not Wolfhouse staff-staging',
    tenant.isWolfhouseStaffStaging(sunsetFlags) === false);
  const wolfOn = {
    WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED: 'true',
    WOLFHOUSE_EMAIL_OAUTH_START_ENABLED: 'true',
    WOLFHOUSE_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'true',
    WOLFHOUSE_EMAIL_OAUTH_DISCONNECT_ENABLED: 'true',
    WOLFHOUSE_EMAIL_STAFF_DRAFTS_ENABLED: 'true',
    WOLFHOUSE_EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
    WOLFHOUSE_EMAIL_LUNA_GENERATE_DRAFT_ENABLED: 'true',
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    LUNA_DEPLOYMENT: 'staff-staging',
  };
  check('B12 Wolfhouse UI exact-true on staff-staging',
    tenant.isWolfhouseEmailSettingsUiEnabled(wolfOn) === true);
  check('B13 send still off when other Wolfhouse flags are on',
    tenant.isWolfhouseEmailOutboundSendEnabled(wolfOn) === false);
  check('B14 truthy junk does not enable send',
    tenant.isWolfhouseEmailOutboundSendEnabled({ WOLFHOUSE_EMAIL_OUTBOUND_SEND_ENABLED: 'TRUE' }) === false);
  check('B15 caller identity is exact slug',
    tenant.isWolfhouseEmailCaller({ client_slug: WH }) === true
    && tenant.isWolfhouseEmailCaller({ client_slug: SUNSET }) === false
    && tenant.isWolfhouseEmailCaller(null) === false);
}

console.log('\n── C. SMTP secret refs independent of Sunset ──');
{
  check('C1 Wolfhouse SMTP names are wolfhouse-smtp-*',
    wolfSmtp.WOLFHOUSE_SMTP_SECRET_NAMES.every((n) => n.startsWith('wolfhouse-smtp-')));
  check('C2 no sunset-smtp-* in Wolfhouse names',
    wolfSmtp.WOLFHOUSE_SMTP_SECRET_NAMES.every((n) => !n.includes('sunset')));
  const sunsetNames = sunsetSmtp.SUNSET_SMTP_SECRET_NAMES || sunsetSmtp.SMTP_SECRET_NAMES || [];
  if (Array.isArray(sunsetNames) && sunsetNames.length) {
    check('C3 Wolfhouse names disjoint from Sunset names',
      wolfSmtp.WOLFHOUSE_SMTP_SECRET_NAMES.every((n) => !sunsetNames.includes(n)));
  } else {
    check('C3 Wolfhouse names disjoint from sunset-smtp-* literals',
      !JSON.stringify(wolfSmtp.WOLFHOUSE_SMTP_SECRET_NAMES).includes('sunset-smtp-'));
  }
  check('C4 runtime refs are opaque kv:',
    wolfSmtp.WOLFHOUSE_SMTP_SECRET_REFS.every((r) => r.startsWith('kv:wolfhouse-smtp-')));
}

console.log('\n── D. Endpoint prepare never proves Sunset ──');
{
  const src = read('scripts/lib/email-wolfhouse-endpoint-prepare.js');
  check('D1 prepare proves wolfhouse via SQL_PROVE_WOLFHOUSE_CLIENT',
    src.includes('SQL_PROVE_WOLFHOUSE_CLIENT')
    && wolfPrepare.SQL_PROVE_WOLFHOUSE_CLIENT.includes("slug = 'wolfhouse-somo'"));
  check('D2 prepare does not prove sunset', !src.includes("slug = 'sunset'"));
  check('D3 Google insert uses Wolfhouse Google secret ref',
    src.includes('WOLFHOUSE_GOOGLE_SECRET_REF')
    && wolfPrepare.WOLFHOUSE_GOOGLE_SECRET_REF === tenant.WOLFHOUSE_GOOGLE_SECRET_REF);
  check('D4 SMTP insert uses Wolfhouse SMTP secret ref',
    src.includes('WOLFHOUSE_SMTP_IDENTITY_SECRET_REF')
    && wolfPrepare.WOLFHOUSE_SMTP_IDENTITY_SECRET_REF === tenant.WOLFHOUSE_SMTP_IDENTITY_SECRET_REF);
  check('D5 no sunset-smtp / sunset-staging oauth secret in prepare',
    !src.includes('sunset-smtp') && !src.includes('sunset-staff-staging-oauth'));
  check('D6 inbound/outbound forced false',
    src.includes('false, false, \'off\', false') || src.includes('inbound_enabled, outbound_enabled'));
  check('D7 exported prepare SQL is Wolfhouse prove',
    wolfPrepare.SQL_PROVE_WOLFHOUSE_CLIENT.includes("slug = 'wolfhouse-somo'"));
}

console.log('\n── E. Remove/disconnect SQL isolation ──');
{
  check('E1 Sunset remove SQL stays sunset',
    remove.SQL_DELETE_REGISTERED_NOT_CONNECTED.includes("WHERE c.slug = 'sunset'"));
  check('E2 Wolfhouse remove SQL is wolfhouse-somo',
    remove.SQL_DELETE_WOLFHOUSE_REGISTERED_NOT_CONNECTED.includes("WHERE c.slug = 'wolfhouse-somo'"));
  check('E3 Wolfhouse remove SQL does not contain sunset slug',
    !remove.SQL_DELETE_WOLFHOUSE_REGISTERED_NOT_CONNECTED.includes("c.slug = 'sunset'"));
  const oauthSrc = read('scripts/lib/staff-email-oauth-routes.js');
  check('E4 MS disconnect Wolfhouse path uses clientSlug wolfhouse-somo',
    oauthSrc.includes("clientSlug: 'wolfhouse-somo'")
    && oauthSrc.includes('isWolfhouseEmailDisconnectEnabled'));
  check('E5 MS Wolfhouse disconnect does not Graph-revoke (leftover remove only)',
    /This slice: leftover remove only/.test(oauthSrc));
  const gmailSrc = read('scripts/lib/staff-email-google-oauth-routes.js');
  check('E6 Gmail Wolfhouse disconnect uses wolfhouse-somo clientSlug',
    gmailSrc.includes("clientSlug: 'wolfhouse-somo'"));
  check('E7 Gmail Wolfhouse start does not call Sunset createStart',
    /Live Google OAuth composition is Sunset-owned/.test(gmailSrc)
    && /handleStart[\s\S]*identityWolfhouse[\s\S]*oauth_start_unavailable/.test(gmailSrc));
}

console.log('\n── F. Settings GET + Admin UI ──');
{
  const settingsSrc = read('scripts/lib/staff-email-settings-routes.js');
  check('F1 settings GET dual-gates wolfhouse-somo + sunset',
    settingsSrc.includes('WOLFHOUSE_CLIENT_SLUG') && settingsSrc.includes('SUNSET_CLIENT_SLUG'));
  check('F2 Wolfhouse GET body.client is tenantSlug not hardcoded sunset',
    settingsSrc.includes('client: tenantSlug'));
  check('F3 Wolfhouse provider actions are a separate function',
    settingsSrc.includes('computeWolfhouseProviderEmailSettingsActions'));
  const apiSrc = read('scripts/staff-query-api.js');
  check('F4 router GET dual-gates Wolfhouse UI flag',
    apiSrc.includes('isWolfhouseEmailSettingsUiEnabled')
    && /isSunsetEmailSettingsUiEnabled\(process\.env\)[\s\S]{0,80}isWolfhouseEmailSettingsUiEnabled/.test(apiSrc));
  check('F5 SMTP identity router dual-gates Wolfhouse register',
    apiSrc.includes('isWolfhouseEmailSmtpIdentityRegisterEnabled'));
  const ui = read('scripts/browser/sunset-admin-email-settings-ui.js');
  check('F6 Email UI fetches wolfhouse-somo for Wolfhouse client',
    ui.includes('/staff/admin/email-settings?client=wolfhouse-somo'));
  check('F7 Email UI still fetches sunset for Sunset client',
    ui.includes('/staff/admin/email-settings?client=sunset'));
  check('F8 Wolfhouse MS redirect is staff-staging',
    ui.includes("WH_REAUTH_UI_REDIRECT_URI = 'https://staff-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback'"));
  check('F9 Sunset MS redirect stays sunset-staging',
    ui.includes("REAUTH_UI_REDIRECT_URI = 'https://sunset-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback'"));
  const whAdmin = read('scripts/browser/wolfhouse-admin-ui.js');
  check('F10 Wolfhouse Email is not a placeholder',
    /WH_ADMIN_PLACEHOLDERS = \{\s*\}/.test(whAdmin));
  check('F11 Email tab loads Admin Email settings',
    whAdmin.includes("next === 'email' && typeof loadAdminEmailSettings === 'function'"));
}

console.log('\n── G. Inbox drafts / send ──');
{
  const wolfUser = { client_slug: WH };
  const sunsetUser = { client_slug: SUNSET };
  const env = {
    EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true',
    EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
    EMAIL_OUTBOUND_SEND_ENABLED: 'true',
    WOLFHOUSE_EMAIL_STAFF_DRAFTS_ENABLED: 'true',
    WOLFHOUSE_EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
  };
  check('G1 Wolfhouse drafts use Wolfhouse flag, not Sunset EMAIL_STAFF_*',
    inbox.isEmailStaffDraftsEnabledForCaller({ EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true' }, wolfUser) === false
    && inbox.isEmailStaffDraftsEnabledForCaller({ WOLFHOUSE_EMAIL_STAFF_DRAFTS_ENABLED: 'true' }, wolfUser) === true);
  check('G2 Sunset drafts still use Sunset EMAIL_STAFF_*',
    inbox.isEmailStaffDraftsEnabledForCaller({ EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true' }, sunsetUser) === true);
  check('G3 Wolfhouse send stays off without WOLFHOUSE_EMAIL_OUTBOUND_SEND_ENABLED',
    inbox.isEmailOutboundSendEnabledForCaller(env, wolfUser) === false);
  check('G4 Sunset send still uses EMAIL_OUTBOUND_SEND_ENABLED',
    inbox.isEmailOutboundSendEnabledForCaller(env, sunsetUser) === true);
  check('G5 Wolfhouse outbound uses Wolfhouse flag',
    inbox.isEmailStaffOutboundEnabledForCaller(env, wolfUser) === true
    && inbox.isEmailStaffOutboundEnabledForCaller({ EMAIL_STAFF_OUTBOUND_ENABLED: 'true' }, wolfUser) === false);
}

console.log('\n── H. Luna drafts use Wolfhouse lodging, not Sunset surf ──');
{
  check('H1 Wolfhouse item names are lodging',
    author.WOLFHOUSE_ITEM_NAMES.private_room.en === 'private room'
    && author.WOLFHOUSE_ITEM_NAMES.dorm_bed.en === 'dorm bed');
  check('H2 Wolfhouse items are not Sunset surf offerings',
    !author.WOLFHOUSE_ITEM_NAMES.board_rental
    && !author.WOLFHOUSE_ITEM_NAMES.group_lesson);
  check('H3 authority helper keys on wolfhouse-somo',
    author.isWolfhouseDraftAuthority({ authority: { location_key: WH } }) === true
    && author.isWolfhouseDraftAuthority({ authority: { location_key: 'sunset-somo' } }) === false);
  const authorSrc = read('scripts/lib/email-luna-draft-author.js');
  check('H4 Wolfhouse author prompt forbids Sunset surf copy',
    authorSrc.includes('This tenant is Wolfhouse lodging in Somo. Never use Sunset surf-school offerings, group lessons, or board rentals.')
    && authorSrc.includes('isWolfhouseDraftAuthority(trusted)'));
  check('H5 Sunset path does not always claim Wolfhouse lodging',
    authorSrc.includes("? ['This tenant is Wolfhouse lodging in Somo. Never use Sunset surf-school offerings, group lessons, or board rentals.']")
    && authorSrc.includes(': []'));
  check('H6 generate SQL Wolfhouse variant pins wolfhouse-somo',
    lunaRoute.SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT_WOLFHOUSE.includes("slug='wolfhouse-somo'")
    && lunaRoute.SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT_WOLFHOUSE.includes("location_id='wolfhouse-somo'"));
  check('H7 generate SQL Wolfhouse variant does not pin sunset',
    !lunaRoute.SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT_WOLFHOUSE.includes("slug='sunset'")
    && !lunaRoute.SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT_WOLFHOUSE.includes("location_id='sunset-somo'"));
  check('H8 Sunset generate SQL stays sunset',
    lunaRoute.SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT.includes("slug='sunset'"));
  const openSrc = read('scripts/lib/staff-email-luna-draft-open.js');
  check('H9 open-draft skips Sunset catalog for wolfhouse-somo',
    openSrc.includes("location_key === 'wolfhouse-somo'")
    && openSrc.includes('queryOwners = null;'));
  check('H10 trusted tenant helper allows Wolfhouse + Sunset separately',
    lunaRoute.isTrustedEmailLunaDraftTenant({
      client_slug: WH, location_key: WH, provider: 'gmail_api',
    }) === true
    && lunaRoute.isTrustedEmailLunaDraftTenant({
      client_slug: SUNSET, location_key: 'sunset-somo', provider: 'microsoft_graph',
    }) === true
    && lunaRoute.isTrustedEmailLunaDraftTenant({
      client_slug: WH, location_key: 'sunset-somo', provider: 'microsoft_graph',
    }) === false
    && lunaRoute.isTrustedEmailLunaDraftTenant({
      client_slug: SUNSET, location_key: WH, provider: 'microsoft_graph',
    }) === false);
}

console.log('\n── I. Inbound is client_id scoped ──');
{
  check('I1 guest bind SQL uses client_id not sunset slug',
    inboundMatch.SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL.includes('client_id = $1')
    && !inboundMatch.SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL.includes("slug = 'sunset'"));
  check('I2 conversation bind SQL uses client_id',
    inboundMatch.SQL_UPDATE_CONVERSATION_GUEST.includes('client_id = $1')
    && !inboundMatch.SQL_UPDATE_CONVERSATION_GUEST.includes("slug = 'sunset'"));
  check('I3 Wolfhouse inbound bind is the same client_id helper',
    inboundMatch.bindWolfhouseGuestByExactInboundEmail === inboundMatch.bindSunsetGuestByExactInboundEmail);
  const bridge = read('scripts/lib/email-inbound-inbox-bridge.js');
  check('I4 inbound bridge projects by client_id',
    bridge.includes('e.client_id = $1::uuid') || bridge.includes('client_id = $1::uuid'));
}

console.log('\n── J. Gmail production integration isolation ──');
{
  const prod = read('scripts/lib/staff-google-oauth-production-integration.js');
  check('J1 Wolfhouse endpoint prepare uses createWolfhouseGoogleEndpointPrepare',
    prod.includes('createWolfhouseGoogleEndpointPrepare'));
  check('J2 Wolfhouse start/callback do not use Sunset composition for Wolfhouse callers',
    prod.includes("kind!=='endpoint'||!wolfEndpointOn"));
  check('J3 Sunset disconnect still requires sunset client access',
    prod.includes("assertStaffClientAccess(user,'sunset'"));
}

console.log('\n── K. Playwright placeholder list emptied ──');
{
  const pw = read('scripts/verify-wolfhouse-admin-tabs-playwright.js');
  check('K1 Email is no longer a placeholder subtab',
    /const PLACEHOLDER_SUBTABS = \[\];/.test(pw));
}

if (failed) {
  console.error(`\nverify-wolfhouse-email-001: FAIL (${failed})`);
  process.exit(1);
}
console.log('\nverify-wolfhouse-email-001: PASS');
