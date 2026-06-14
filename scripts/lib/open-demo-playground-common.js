'use strict';

/**
 * Stage 28f — shared helpers for open-demo playground report + cleanup CLIs.
 * Staging/test tooling only.
 */

const path = require('path');
const { execSync } = require('child_process');
const { normalizeResetPhone } = require('./luna-test-reset-phone');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'infra', '.env') });

const CLIENT_SLUG = 'wolfhouse-somo';
const DEFAULT_BASE_URL = 'https://staff-staging.lunafrontdesk.com';
const DEFAULT_PHONE = '+491726422307';
const DEFAULT_LIMIT = 20;
const N8N_WORKFLOW_ID = 'stage27demoLWrite01';
const DEMO_PHONE_NUMBER_ID = '1152900101233109';
const STAFF_API_APP = 'wh-staging-staff-api';
const STAFF_API_RG = 'wh-staging-rg';

/** Stage 28g — staging guest playground ON (live replies + booking writes). */
const PLAYGROUND_ON_ENV = {
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_NUMBER_ID,
  WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_NUMBER_ID,
};

/** Safe baseline after playground OFF. */
const PLAYGROUND_OFF_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_NUMBER_ID,
};

const GATE_NAMES = [
  'WHATSAPP_DRY_RUN',
  'OPEN_DEMO_WHATSAPP_ENABLED',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_PHONE_NUMBER_ID',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
];

const PROD_DB_PATTERNS = [
  /wolfhouse\.com(?!\.(test|local|staging|dev))/i,
  /prod(?:uction)?[\-._]/i,
  /\.prod\./i,
  /rds\.amazonaws\.com/i,
  /database\.windows\.net/i,
];

const STAGING_DB_SIGNALS = /staging|localhost|127\.0\.0\.1|:5433\/|wh-staging|azure.*postgres/i;

const PAID_BOOKING_PAYMENT_STATUSES = new Set(['deposit_paid', 'paid']);
const PAID_PAYMENT_ROW_STATUSES = new Set(['paid']);
const UNPAID_PAYMENT_CANCEL_STATUSES = ['draft', 'checkout_created', 'pending'];

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function redactUrl(url) {
  return String(url || '').replace(/:([^:@]+)@/, ':***@');
}

function defaultConnectionString() {
  return (
    process.env.WOLFHOUSE_DATABASE_URL ||
    `postgres://${process.env.WOLFHOUSE_DB_USER || 'wolfhouse'}:${process.env.WOLFHOUSE_DB_PASSWORD || ''}@localhost:${process.env.WOLFHOUSE_DB_PORT || 5433}/${process.env.WOLFHOUSE_DB_NAME || 'wolfhouse'}`
  );
}

function assertNotProductionDb(url) {
  const conn = trimStr(url);
  if (!conn) {
    throw new Error('database URL missing — set WOLFHOUSE_DATABASE_URL or pass --db-url');
  }
  for (const pat of PROD_DB_PATTERNS) {
    if (pat.test(conn)) {
      throw new Error(`production database URL refused (${pat}) — ${redactUrl(conn)}`);
    }
  }
  if (trimStr(process.env.NODE_ENV).toLowerCase() === 'production') {
    throw new Error('NODE_ENV=production refused for open-demo playground tooling');
  }
  if (!STAGING_DB_SIGNALS.test(conn) && trimStr(process.env.NODE_ENV).toLowerCase() !== 'development') {
    throw new Error(`database URL lacks staging/local signal — refused (${redactUrl(conn)})`);
  }
}

function parsePhoneVariants(phone) {
  const raw = normalizeResetPhone(phone || DEFAULT_PHONE);
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  return { raw, e164, like: `%${raw}%` };
}

function parseBaseArgs(argv) {
  const flags = {
    phone: DEFAULT_PHONE,
    limit: DEFAULT_LIMIT,
    json: false,
    baseUrl: DEFAULT_BASE_URL,
    dbUrl: null,
    bookingCode: null,
    dryRun: true,
    confirmCleanup: false,
    allowPaid: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--phone':
        flags.phone = argv[++i];
        break;
      case '--limit':
        flags.limit = Math.max(1, Math.min(100, Number(argv[++i]) || DEFAULT_LIMIT));
        break;
      case '--json':
        flags.json = true;
        break;
      case '--base-url':
        flags.baseUrl = trimStr(argv[++i]).replace(/\/$/, '');
        break;
      case '--db-url':
        flags.dbUrl = argv[++i];
        break;
      case '--booking-code':
        flags.bookingCode = trimStr(argv[++i]);
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--confirm-cleanup':
        flags.confirmCleanup = true;
        flags.dryRun = false;
        break;
      case '--allow-paid':
        flags.allowPaid = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        flags.unknown = flags.unknown || [];
        flags.unknown.push(arg);
        break;
    }
  }
  return flags;
}

function tryAz(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return { error: trimStr(err.stderr || err.message) };
  }
}

function fetchStaffApiGates() {
  const raw = tryAz(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  );
  if (raw && typeof raw === 'object' && raw.error) {
    return { status: 'not_checked', reason: raw.error };
  }
  try {
    const env = JSON.parse(raw);
    const gates = {};
    for (const name of GATE_NAMES) {
      const row = env.find((x) => x.name === name);
      gates[name] = row ? (row.secretRef ? `(secret:${row.secretRef})` : row.value) : null;
    }
    return { status: 'checked', gates };
  } catch (err) {
    return { status: 'not_checked', reason: err.message };
  }
}

function fetchMetaCallback() {
  let token = trimStr(process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_WHATSAPP_ACCESS_TOKEN);
  if (!token) {
    const secret = tryAz(
      'az keyvault secret show --vault-name wh-staging-kv --name whatsapp-access-token --query value -o tsv',
    );
    if (typeof secret === 'string' && secret && !secret.error) token = secret;
  }
  if (!token || (typeof token === 'object' && token.error)) {
    return { status: 'not_checked', reason: 'no WhatsApp access token available' };
  }

  const https = require('https');
  return new Promise((resolve) => {
    const url = `https://graph.facebook.com/v21.0/${DEMO_PHONE_NUMBER_ID}?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`;
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const body = JSON.parse(buf);
          if (body.error) {
            resolve({ status: 'not_checked', reason: body.error.message || 'graph error' });
            return;
          }
          resolve({
            status: 'checked',
            display_phone_number: body.display_phone_number || null,
            webhook_callback_url: body.webhook_configuration?.application || null,
          });
        } catch (err) {
          resolve({ status: 'not_checked', reason: err.message });
        }
      });
    }).on('error', (err) => resolve({ status: 'not_checked', reason: err.message }));
  });
}

async function fetchN8nWorkflowStatus() {
  let n8nUrl = trimStr(process.env.N8N_DATABASE_URL);
  if (!n8nUrl) {
    const secret = tryAz(
      'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    );
    if (typeof secret === 'string' && secret && !secret.error) n8nUrl = secret;
  }
  if (!n8nUrl || (typeof n8nUrl === 'object' && n8nUrl.error)) {
    return { status: 'not_checked', reason: 'n8n database URL unavailable' };
  }

  const { Client } = require('pg');
  const pg = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  try {
    await pg.connect();
    const wf = await pg.query('SELECT id, active FROM workflow_entity WHERE id = $1', [N8N_WORKFLOW_ID]);
    const hooks = await pg.query('SELECT COUNT(*)::int AS n FROM webhook_entity WHERE "workflowId" = $1', [N8N_WORKFLOW_ID]);
    return {
      status: 'checked',
      workflow_id: N8N_WORKFLOW_ID,
      workflow_active: wf.rows[0]?.active ?? null,
      webhook_entity_rows: hooks.rows[0]?.n ?? 0,
    };
  } catch (err) {
    return { status: 'not_checked', reason: err.message };
  } finally {
    try { await pg.end(); } catch { /* ignore */ }
  }
}

function assessCleanupEligibility(booking, payments, opts = {}) {
  const reasons = [];
  if (!booking) {
    return { eligible: false, reasons: ['booking_not_found'] };
  }
  if (opts.allowPaid) {
    return {
      eligible: false,
      reasons: ['paid_cleanup_not_implemented'],
      warning: '--allow-paid is not implemented in Stage 28f; unpaid holds only',
    };
  }
  if (booking.confirmation_sent_at) reasons.push('confirmation_already_sent');
  if (PAID_BOOKING_PAYMENT_STATUSES.has(trimStr(booking.payment_status).toLowerCase())) {
    reasons.push(`booking_payment_status_${booking.payment_status}`);
  }
  if (['confirmed', 'checked_in'].includes(trimStr(booking.status).toLowerCase())) {
    reasons.push(`booking_status_${booking.status}`);
  }
  if ((payments || []).some((p) => PAID_PAYMENT_ROW_STATUSES.has(trimStr(p.status).toLowerCase()))) {
    reasons.push('payment_row_paid');
  }
  if (['cancelled', 'canceled', 'expired'].includes(trimStr(booking.status).toLowerCase())) {
    reasons.push(`booking_already_${booking.status}`);
  }
  return { eligible: reasons.length === 0, reasons };
}

function azExec(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setStaffApiEnvVars(pairs) {
  const args = Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ');
  azExec([
    'az containerapp update',
    `--name ${STAFF_API_APP}`,
    `--resource-group ${STAFF_API_RG}`,
    `--set-env-vars ${args}`,
    '-o none',
  ].join(' '));
}

function removeStaffApiEnvVars(names) {
  if (!names.length) return;
  azExec([
    'az containerapp update',
    `--name ${STAFF_API_APP}`,
    `--resource-group ${STAFF_API_RG}`,
    `--remove-env-vars ${names.join(' ')}`,
    '-o none',
  ].join(' '));
}

async function setGuestPhoneInactive(pg, phone) {
  const { raw, e164 } = parsePhoneVariants(phone);
  const before = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug=$1 AND (phone_normalized=$2 OR phone_e164=$3)`,
    [CLIENT_SLUG, raw, e164],
  );
  await pg.query(
    `UPDATE staff_phone_access SET is_active=false, updated_at=NOW()
      WHERE client_slug=$1 AND (phone_normalized=$2 OR phone_e164=$3 OR phone_e164=$4)`,
    [CLIENT_SLUG, raw, e164, phone],
  );
  const after = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug=$1 AND (phone_normalized=$2 OR phone_e164=$3)`,
    [CLIENT_SLUG, raw, e164],
  );
  return { before: before.rows[0] || null, after: after.rows[0] || null };
}

async function restoreGuestPhoneOwner(pg, phone) {
  const { raw, e164 } = parsePhoneVariants(phone);
  await pg.query(
    `UPDATE staff_phone_access SET is_active=true, updated_at=NOW()
      WHERE client_slug=$1 AND (phone_normalized=$2 OR phone_e164=$3 OR phone_e164=$4)`,
    [CLIENT_SLUG, raw, e164, phone],
  );
  const after = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug=$1 AND (phone_normalized=$2 OR phone_e164=$3)`,
    [CLIENT_SLUG, raw, e164],
  );
  return after.rows[0] || null;
}

module.exports = {
  CLIENT_SLUG,
  DEFAULT_BASE_URL,
  DEFAULT_PHONE,
  DEFAULT_LIMIT,
  DEMO_PHONE_NUMBER_ID,
  STAFF_API_APP,
  STAFF_API_RG,
  GATE_NAMES,
  PLAYGROUND_ON_ENV,
  PLAYGROUND_OFF_ENV,
  UNPAID_PAYMENT_CANCEL_STATUSES,
  assertNotProductionDb,
  assessCleanupEligibility,
  azExec,
  defaultConnectionString,
  fetchMetaCallback,
  fetchN8nWorkflowStatus,
  fetchStaffApiGates,
  parseBaseArgs,
  parsePhoneVariants,
  redactUrl,
  removeStaffApiEnvVars,
  restoreGuestPhoneOwner,
  setGuestPhoneInactive,
  setStaffApiEnvVars,
  trimStr,
};
